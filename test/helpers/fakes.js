// -----------------------------------------------------------------------------
// Test doubles: a clock whose timers only fire when the test advances it, and
// a fake SDCP printer behind a fake WebSocket. No network.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export class FakeClock {
  constructor(start = Date.UTC(2026, 9, 17, 12)) {
    this.time = start;
    this.timers = new Map();
    this.next = 1;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => this.add(fn, ms, 0);
    this.setInterval = (fn, ms) => this.add(fn, ms, ms);
    this.clearTimeout = (id) => this.timers.delete(id);
    this.clearInterval = (id) => this.timers.delete(id);
  }

  add(fn, ms, every) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + Math.max(0, ms ?? 0), fn, every });
    return id;
  }

  /** Moves the clock forward, firing the due timers in order. */
  async advance(ms) {
    const target = this.time + ms;
    for (;;) {
      let dueId;
      let due;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (!due || timer.at < due.at)) {
          dueId = id;
          due = timer;
        }
      }
      if (!due) break;
      this.time = due.at;
      if (due.every) {
        due.at += due.every;
      } else {
        this.timers.delete(dueId);
      }
      due.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

export const RESIN_ID = '000000000001d354';
export const FDM_ID = '0000000000a1b2c3';

/** A fake SDCP printer: answers the requests and pushes its status. */
export class FakePrinter {
  constructor({
    id = RESIN_ID,
    connectionId = 'f25273b12b094c5a8b9513a30ca60049',
    name = 'Saturn',
    model = 'ELEGOO Saturn 4 Ultra',
    ip = '192.168.1.50',
    status,
  } = {}) {
    this.id = id;
    this.connectionId = connectionId;
    this.name = name;
    this.model = model;
    this.ip = ip;
    this.status = status ?? resinStatus();
    this.requests = [];
    this.acks = {};
    this.silent = false;
    this.socket = undefined;
  }

  discoveryReply() {
    return JSON.stringify({
      Id: this.connectionId,
      Data: {
        Name: this.name,
        MachineName: this.model,
        BrandName: 'ELEGOO',
        MainboardIP: this.ip,
        MainboardID: this.id,
        ProtocolVersion: 'V3.0.0',
        FirmwareVersion: 'V1.2.3',
      },
    });
  }

  identity() {
    return {
      mainboardId: this.id,
      connectionId: this.connectionId,
      name: this.name,
      model: this.model,
      brand: 'ELEGOO',
      firmware: 'V1.2.3',
      protocol: 'V3.0.0',
      ip: this.ip,
    };
  }

  /** The text frames, as the printer sends them. */
  statusFrame() {
    return {
      Status: this.status,
      MainboardID: this.id,
      TimeStamp: 1687069655,
      Topic: `sdcp/status/${this.id}`,
    };
  }

  attributesFrame() {
    return {
      Attributes: {
        Name: this.name,
        MachineName: this.model,
        BrandName: 'ELEGOO',
        ProtocolVersion: 'V3.0.0',
        FirmwareVersion: 'V1.2.3',
        MainboardIP: this.ip,
        MainboardID: this.id,
      },
      MainboardID: this.id,
      TimeStamp: 1687069655,
      Topic: `sdcp/attributes/${this.id}`,
    };
  }

  push(frame) {
    this.socket?.deliver(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  pushStatus(patch) {
    if (patch) {
      this.status = merge(this.status, patch);
    }
    this.push(this.statusFrame());
  }

  received(text) {
    if (text === 'ping') {
      this.requests.push('ping');
      if (!this.silent && this.textPong !== false) queueMicrotask(() => this.push('pong'));
      return;
    }
    const request = JSON.parse(text);
    this.requests.push(request);
    if (this.silent) return;
    const cmd = request.Data.Cmd;
    const ack = this.acks[cmd] ?? 0;
    queueMicrotask(() => {
      this.push({
        Id: this.connectionId,
        Data: {
          Cmd: cmd,
          Data: { Ack: ack },
          RequestID: request.Data.RequestID,
          MainboardID: this.id,
          TimeStamp: 1687069655,
        },
        Topic: `sdcp/response/${this.id}`,
      });
      if (cmd === 0) this.pushStatus();
      if (cmd === 1) this.push(this.attributesFrame());
    });
  }

  commands() {
    return this.requests.filter((r) => r !== 'ping').map((r) => r.Data.Cmd);
  }
}

const merge = (base, patch) => {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base[key] ?? {}, value)
        : value;
  }
  return out;
};

export function resinStatus(patch = {}) {
  return merge(
    {
      CurrentStatus: [1],
      PreviousStatus: 0,
      PrintScreen: 0,
      ReleaseFilm: 0,
      TempOfUVLED: 31.2,
      TimeLapseStatus: 0,
      TempOfBox: 0,
      TempTargetBox: 0,
      PrintInfo: {
        Status: 3,
        CurrentLayer: 250,
        TotalLayer: 1000,
        CurrentTicks: 1_800_000,
        TotalTicks: 7_200_000,
        Filename: 'benchy.ctb',
        ErrorNumber: 0,
        TaskId: 'task-1',
      },
    },
    patch,
  );
}

export function fdmStatus(patch = {}) {
  return merge(
    {
      CurrentStatus: [1],
      PreviousStatus: 0,
      TempOfNozzle: 219.6,
      TempTargetNozzle: 220,
      TempOfHotbed: 60.04,
      TempTargetHotbed: 60,
      TempOfBox: 32.5,
      TempTargetBox: 0,
      CurrentFanSpeed: { ModelFan: 100, AuxiliaryFan: 30, BoxFan: 0 },
      PrintInfo: {
        Status: 13,
        CurrentLayer: 40,
        TotalLayer: 200,
        CurrentTicks: 1200,
        TotalTicks: 3600,
        Progress: 33,
        Filename: 'cube.gcode',
        ErrorNumber: 0,
        TaskId: 'fdm-task-1',
      },
    },
    patch,
  );
}

/** A fake `ws` socket bound to a printer (or to nothing: the connection never opens). */
export class FakeSocket extends EventEmitter {
  constructor(url, printer) {
    super();
    this.url = url;
    this.printer = printer;
    this.sent = [];
    this.closed = false;
    if (printer) printer.socket = this;
  }

  open() {
    this.emit('open');
  }

  deliver(text) {
    if (!this.closed) this.emit('message', Buffer.from(text), false);
  }

  send(text) {
    this.sent.push(text);
    this.printer?.received(text);
  }

  /** WebSocket ping frame: answered by a pong frame unless the printer is silent. */
  ping() {
    this.pings = (this.pings ?? 0) + 1;
    if (!this.printer?.silent) queueMicrotask(() => this.emit('pong'));
  }

  terminate() {
    this.closed = true;
  }

  close() {
    this.closed = true;
  }

  /** The printer drops the connection. */
  drop(code = 1006) {
    this.closed = true;
    this.emit('close', code);
  }
}
