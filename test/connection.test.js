import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probe } from '../src/sdcp/probe.js';
import { PrinterConnection, createWebSocket, socketUrl } from '../src/sdcp/connection.js';
import { CMD, TIMINGS } from '../src/constants.js';
import { FakeClock, FakePrinter, FakeSocket, RESIN_ID, flush } from './helpers/fakes.js';

function setup({ printer = new FakePrinter(), autoOpen = true } = {}) {
  const clock = new FakeClock();
  const sockets = [];
  const connection = new PrinterConnection({
    host: '192.168.1.50',
    timers: clock,
    now: clock.now,
    createSocket: (url) => {
      const socket = new FakeSocket(url, printer);
      sockets.push(socket);
      if (autoOpen) queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const events = [];
  connection.on('up', () => events.push('up'));
  connection.on('down', (info) => events.push(['down', info.retryIn]));
  connection.on('message', (m) => events.push(m.kind));
  connection.setIdentity({ mainboardId: printer.id, connectionId: printer.connectionId });
  return { clock, sockets, connection, events, printer };
}

test('the WebSocket address and its limits', () => {
  assert.equal(socketUrl('192.168.1.50'), 'ws://192.168.1.50:3030/websocket');
  assert.equal(socketUrl('fe80::1'), 'ws://[fe80::1]:3030/websocket');
  const made = [];
  class Spy {
    constructor(url, options) {
      made.push({ url, options });
    }
  }
  createWebSocket('ws://192.168.1.50:3030/websocket', Spy);
  assert.equal(made[0].url, 'ws://192.168.1.50:3030/websocket');
  assert.equal(made[0].options.maxPayload, 256 * 1024);
  assert.equal(made[0].options.perMessageDeflate, false);
  assert.equal(made[0].options.followRedirects, false);
  assert.equal(made[0].options.handshakeTimeout, TIMINGS.connectTimeout);
});

test('only status, attributes, pause, stop and resume can ever be sent', async (t) => {
  assert.deepEqual(
    Object.values(CMD).sort((a, b) => a - b),
    [0, 1, 129, 130, 131],
  );
  const { connection, printer } = setup();
  t.after(() => connection.stop());
  connection.start();
  await flush();
  for (const cmd of [128, 132, 133, 192, 255, 258, 259, 386, 401, 402, 403]) {
    await assert.rejects(connection.request(cmd), { kind: 'forbidden' }, `command ${cmd}`);
  }
  assert.deepEqual(printer.commands(), []);
});

test('connects, sends the protocol heartbeat, and matches the answers', async (t) => {
  const { clock, sockets, connection, events, printer } = setup();
  t.after(() => connection.stop());
  connection.start();
  await flush();
  assert.equal(connection.connected, true);
  assert.equal(sockets[0].url, 'ws://192.168.1.50:3030/websocket');
  await clock.advance(TIMINGS.heartbeat);
  assert.equal(sockets[0].sent.at(-1), 'ping');
  assert.equal(sockets[0].pings, 1, 'and a WebSocket ping frame');
  const answer = await connection.request(129);
  assert.deepEqual([answer.cmd, answer.ack], [129, 0]);
  const request = printer.requests.at(-1);
  assert.equal(request.Data.MainboardID, RESIN_ID);
  assert.equal(request.Id, printer.connectionId);
  assert.match(request.Data.RequestID, /^[0-9a-f]{16}$/);
  assert.deepEqual(events.slice(0, 2), ['up', 'response']);
});

test('a request without an answer times out; a lost connection fails the waiting ones', async (t) => {
  const { clock, sockets, connection, printer } = setup();
  t.after(() => connection.stop());
  connection.start();
  await flush();
  printer.silent = true;
  const late = connection.request(131, {}, { timeout: 1000 });
  late.catch(() => {});
  await clock.advance(1000);
  await assert.rejects(late, { kind: 'timeout' });
  const lost = connection.request(130);
  sockets[0].drop();
  await assert.rejects(lost, { kind: 'lost' }, 'sent, then the connection dropped');
  await assert.rejects(connection.request(130), { kind: 'offline' });
});

test('no identity yet: no request is sent', async (t) => {
  const { connection } = setup();
  t.after(() => connection.stop());
  connection.setIdentity(undefined);
  connection.start();
  await flush();
  await assert.rejects(connection.request(0), { kind: 'unknown' });
});

test('the watchdog closes a silent connection, the delays grow and stay bounded', async (t) => {
  const { clock, sockets, connection, events, printer } = setup();
  t.after(() => connection.stop());
  printer.silent = true;
  connection.start();
  await flush();
  await clock.advance(TIMINGS.watchdog + TIMINGS.heartbeat);
  assert.ok(sockets[0].closed, 'closed by the watchdog');
  assert.deepEqual(
    events.filter((e) => Array.isArray(e)),
    [['down', TIMINGS.backoff[0]]],
  );
  // The printer is gone: the next tries never open.
  const failing = setup({ autoOpen: false });
  t.after(() => failing.connection.stop());
  failing.connection.start();
  for (let i = 0; i < 10; i += 1) {
    await failing.clock.advance(TIMINGS.connectTimeout);
    await failing.clock.advance(TIMINGS.backoff.at(-1));
  }
  const delays = failing.events.filter((e) => Array.isArray(e)).map(([, d]) => d);
  assert.deepEqual(delays.slice(0, TIMINGS.backoff.length), TIMINGS.backoff);
  assert.ok(delays.every((d) => d <= TIMINGS.backoff.at(-1)));
});

test('a firmware that ignores the "ping" text stays alive on WebSocket pongs', async (t) => {
  const { clock, sockets, connection, events, printer } = setup();
  t.after(() => connection.stop());
  printer.textPong = false;
  connection.start();
  await flush();
  await clock.advance(TIMINGS.watchdog * 3);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);
  assert.ok(!events.some((e) => Array.isArray(e)));
});

test('a connection that lived long resets the delays', async (t) => {
  const { clock, sockets, connection, events } = setup();
  t.after(() => connection.stop());
  connection.start();
  await flush();
  sockets[0].drop();
  await clock.advance(TIMINGS.backoff[0]);
  await flush();
  sockets[1].drop();
  await clock.advance(TIMINGS.backoff[1]);
  await flush();
  await clock.advance(TIMINGS.stableAfter);
  sockets[2].drop();
  const delays = events.filter((e) => Array.isArray(e)).map(([, d]) => d);
  assert.deepEqual(delays, [TIMINGS.backoff[0], TIMINGS.backoff[1], TIMINGS.backoff[0]]);
});

test('invalid, binary and foreign messages are ignored', async (t) => {
  const { connection, sockets, events } = setup();
  t.after(() => connection.stop());
  connection.start();
  await flush();
  sockets[0].emit('message', Buffer.from([1, 2, 3]), true);
  sockets[0].deliver('{"Topic":"evil"}');
  sockets[0].deliver('not json');
  assert.equal(connection.invalid, 2);
  assert.deepEqual(events, ['up']);
});

test('the unicast probe only trusts the answer of the typed IP', async () => {
  const printer = new FakePrinter();
  const fakeUdp = (answers) => () => {
    const socket = new EventEmitter();
    socket.close = () => {};
    socket.send = (data, port, host, done) => {
      assert.equal(String(data), 'M99999');
      assert.equal(port, 3000);
      done();
      for (const [from, text] of answers) {
        queueMicrotask(() => socket.emit('message', Buffer.from(text), { address: from }));
      }
    };
    return socket;
  };
  const reply = printer.discoveryReply();
  assert.equal(
    (await probe('192.168.1.50', { create: fakeUdp([['192.168.1.50', reply]]) })).mainboardId,
    RESIN_ID,
  );
  assert.equal(
    await probe('192.168.1.50', { timeout: 20, create: fakeUdp([['192.168.1.66', reply]]) }),
    undefined,
    'another machine answering',
  );
  assert.equal(
    (await probe('192.168.1.50', { create: fakeUdp([['::ffff:192.168.1.50', reply]]) }))
      .mainboardId,
    RESIN_ID,
  );
});

test('stop: no reconnection', async () => {
  const { clock, sockets, connection } = setup();
  connection.start();
  await flush();
  connection.stop();
  await clock.advance(TIMINGS.backoff.at(-1) * 2);
  assert.equal(sockets.length, 1);
  assert.equal(connection.connected, false);
});
