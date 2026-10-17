import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrinterConnection, createWebSocket, socketUrl } from '../src/sdcp/connection.js';
import { TIMINGS } from '../src/constants.js';
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
  const socket = createWebSocket('ws://127.0.0.1:1/websocket');
  socket.on('error', () => {});
  assert.equal(socket._maxPayload ?? 256 * 1024, 256 * 1024);
  socket.terminate();
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
  await assert.rejects(lost, { kind: 'offline' });
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

test('stop: no reconnection', async () => {
  const { clock, sockets, connection } = setup();
  connection.start();
  await flush();
  connection.stop();
  await clock.advance(TIMINGS.backoff.at(-1) * 2);
  assert.equal(sockets.length, 1);
  assert.equal(connection.connected, false);
});
