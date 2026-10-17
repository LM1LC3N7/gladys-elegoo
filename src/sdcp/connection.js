// -----------------------------------------------------------------------------
// One WebSocket to one printer (ws://<host>:3030/websocket): connection,
// protocol heartbeat, watchdog, reconnection with growing bounded delays,
// bounded and validated messages, requests matched to their answers.
//
// Events: 'up', 'down' { reason, retryIn, wasUp }, 'message' (a parsed frame
// of src/sdcp/protocol.js: status, attributes, error, notice; the responses
// are matched to their request here and also emitted).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CMD, LIMITS, SDCP, TIMINGS } from '../constants.js';
import { buildRequest, parseMessage, parseResponse } from './protocol.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const MAX_PENDING = 20;

export class SdcpError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

/** ws://host:3030/websocket (an IPv6 address between brackets). */
export const socketUrl = (host) =>
  `ws://${host.includes(':') ? `[${host}]` : host}:${SDCP.wsPort}${SDCP.wsPath}`;

export function createWebSocket(url) {
  return new WebSocket(url, {
    // A message larger than this closes the connection (code 1009) before it is buffered.
    maxPayload: LIMITS.messageBytes,
    handshakeTimeout: TIMINGS.connectTimeout,
    perMessageDeflate: false,
    followRedirects: false,
  });
}

export class PrinterConnection extends EventEmitter {
  constructor({
    host,
    createSocket = createWebSocket,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  }) {
    super();
    this.host = host;
    this.createSocket = createSocket;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    /** { mainboardId, connectionId } once known (UDP probe, attributes or first frame). */
    this.identity = undefined;
    this.socket = undefined;
    this.open = false;
    this.running = false;
    this.generation = 0;
    this.failures = 0;
    this.upAt = 0;
    this.lastReceived = 0;
    this.pending = new Map();
    this.connectTimer = undefined;
    this.ticker = undefined;
    this.reconnectTimer = undefined;
    this.invalid = 0;
  }

  get connected() {
    return this.open;
  }

  setIdentity(identity) {
    this.identity = identity ? { ...identity } : undefined;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.failures = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close('stopped');
  }

  connect() {
    const generation = ++this.generation;
    const url = socketUrl(this.host);
    this.logger.debug(`Connecting to ${url}`);
    let socket;
    try {
      socket = this.createSocket(url);
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on('open', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.open = true;
      this.upAt = this.now();
      this.lastReceived = this.upAt;
      this.ticker = this.timers.setInterval(() => this.tick(generation), TIMINGS.heartbeat);
      this.logger.info(`Connected to the printer at ${this.host}`);
      this.emit('up');
    });
    socket.on('message', (data, isBinary) => {
      if (generation === this.generation) this.received(data, isBinary);
    });
    socket.on('error', (err) => this.lost(generation, err?.code ?? err?.message ?? 'error'));
    socket.on('close', (code) => this.lost(generation, `connection closed (${code ?? '-'})`));
  }

  /** Closes the socket and fails the requests waiting for an answer. */
  close(reason) {
    if (this.connectTimer) {
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    if (this.ticker) {
      this.timers.clearInterval(this.ticker);
      this.ticker = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.open = false;
    if (socket) {
      socket.removeAllListeners?.();
      socket.on?.('error', () => undefined);
      try {
        socket.terminate ? socket.terminate() : socket.close();
      } catch {
        // Already closed.
      }
    }
    for (const [, waiter] of this.pending) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new SdcpError(`Connection to the printer lost (${reason})`, 'offline'));
    }
    this.pending.clear();
  }

  /** The connection ended (error, close, timeout, watchdog): reconnect later unless stopped. */
  lost(generation, reason) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.open;
    if (wasUp && this.now() - this.upAt >= TIMINGS.stableAfter) {
      this.failures = 0;
    }
    this.close(reason);
    if (!this.running) return;
    const retryIn = TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)];
    this.failures += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) this.connect();
    }, retryIn);
    this.logger.debug(`Printer at ${this.host}: ${reason}, retry in ${retryIn / 1000} s`);
    this.emit('down', { reason, retryIn, wasUp });
  }

  tick(generation) {
    if (generation !== this.generation || !this.open) return;
    if (this.now() - this.lastReceived > TIMINGS.watchdog) {
      this.logger.warn(`Printer at ${this.host}: nothing received for too long, reconnecting`);
      this.lost(generation, 'no answer from the printer');
      return;
    }
    this.send(SDCP.ping);
  }

  received(data, isBinary) {
    this.lastReceived = this.now();
    if (isBinary) {
      return;
    }
    const message = parseMessage(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    if (message.kind === 'pong') {
      return;
    }
    if (message.kind === 'invalid') {
      this.invalid += 1;
      this.logger.debug(`Printer at ${this.host}: message ignored (${message.reason})`);
      return;
    }
    if (message.kind === 'response') {
      const response = parseResponse(message.body);
      const waiter = response && this.pending.get(response.requestId);
      if (waiter) {
        this.pending.delete(response.requestId);
        this.timers.clearTimeout(waiter.timer);
        waiter.resolve(response);
      }
    }
    this.emit('message', message);
  }

  send(text) {
    if (!this.open || !this.socket) {
      throw new SdcpError('Not connected to the printer', 'offline');
    }
    this.socket.send(text);
  }

  /**
   * Sends a command and resolves with its answer `{ cmd, requestId, ack }`.
   * Rejects when not connected, the board id is unknown, or no answer comes
   * within `timeout` ms.
   */
  request(cmd, data = {}, { timeout = TIMINGS.commandAck } = {}) {
    if (!this.open) {
      return Promise.reject(new SdcpError('Not connected to the printer', 'offline'));
    }
    if (!this.identity?.mainboardId) {
      return Promise.reject(new SdcpError('Printer not identified yet', 'unknown'));
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new SdcpError('Too many requests waiting', 'busy'));
    }
    const requestId = randomBytes(8).toString('hex');
    const text = buildRequest({
      cmd,
      data,
      mainboardId: this.identity.mainboardId,
      connectionId: this.identity.connectionId ?? '',
      requestId,
      now: this.now(),
    });
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SdcpError('No answer from the printer', 'timeout'));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send(text);
        this.logger.debug(`Printer at ${this.host} <- command ${cmd}`);
      } catch (err) {
        this.timers.clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  /** Asks for the status and the attributes again (no answer awaited). */
  refresh({ attributes = false } = {}) {
    for (const cmd of attributes ? [CMD.STATUS, CMD.ATTRIBUTES] : [CMD.STATUS]) {
      this.request(cmd, {}, { timeout: TIMINGS.commandAck }).catch((err) =>
        this.logger.debug(`Printer at ${this.host}: refresh ${cmd}: ${err.message}`),
      );
    }
  }
}
