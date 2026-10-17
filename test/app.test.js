// -----------------------------------------------------------------------------
// ElegooApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), fake printers behind fake WebSockets, a memory store and
// a clock the tests advance. No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ElegooApp } from '../src/app.js';
import { CMD, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import {
  FDM_ID,
  FakeClock,
  FakePrinter,
  FakeSocket,
  RESIN_ID,
  fdmStatus,
  flush,
} from './helpers/fakes.js';

const SELECTOR = 'elegoo';
const id = (board, key) => `ext:${SELECTOR}:printer:${board}${key ? `:${key}` : ''}`;

async function setup(
  t,
  {
    config = { addresses: '192.168.1.50' },
    printers = { '192.168.1.50': new FakePrinter() },
    answerProbe = true,
    store = new MemoryStore(),
    scanResults = {},
    devices = [],
  } = {},
) {
  const clock = new FakeClock();
  const gladys = createFakeGladys({ selector: SELECTOR, config, scanResults, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const sockets = [];
  const probes = [];
  const app = new ElegooApp({
    gladys,
    logger,
    store,
    now: clock.now,
    timers: clock,
    probe: async (host) => {
      probes.push(host);
      return answerProbe ? printers[host]?.identity() : undefined;
    },
    createConnection: undefined,
  });
  // The real PrinterConnection, on fake sockets.
  const { PrinterConnection } = await import('../src/sdcp/connection.js');
  app.createConnection = (options) =>
    new PrinterConnection({
      ...options,
      createSocket: (url) => {
        const host = /ws:\/\/(.*):3030/.exec(url)[1];
        const socket = new FakeSocket(url, printers[host]);
        sockets.push(socket);
        if (printers[host]) queueMicrotask(() => socket.open());
        return socket;
      },
    });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  return { gladys, app, clock, logs, sockets, probes, printers, store };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

test('a typed address: probed, connected, then in the Discovery tab', async (t) => {
  const { gladys, probes, printers } = await setup(t);
  assert.deepEqual(probes, ['192.168.1.50']);
  const printer = printers['192.168.1.50'];
  // Status and attributes asked once connected and identified.
  assert.ok(printer.commands().includes(CMD.STATUS));
  assert.ok(printer.commands().includes(CMD.ATTRIBUTES));
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id(RESIN_ID));
  assert.equal(device.name, 'Saturn');
  assert.deepEqual(
    device.params.find((p) => p.name === 'PRINTER_TYPE'),
    { name: 'PRINTER_TYPE', value: 'resin' },
  );
  assert.ok(device.features.some((f) => f.external_id === id(RESIN_ID, 'uvled-temperature')));
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 of 1 printer\(s\) connected/);
});

test('states: only for created devices, the last ones sent at creation', async (t) => {
  const { gladys, app } = await setup(t);
  await app.publisher.flush();
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(id(RESIN_ID, 'state')), 'Impression');
  assert.equal(gladys.fake.lastState(id(RESIN_ID, 'progress')), 25);
  assert.equal(gladys.fake.lastState(id(RESIN_ID, 'remaining')), 90);
  assert.equal(gladys.fake.lastState(id(RESIN_ID, 'file')), 'benchy.ctb');
  assert.equal(gladys.fake.lastState(id(RESIN_ID, 'uvled-temperature')), 31.2);
  assert.deepEqual(
    gladys.fake.transports.map((e) => e.transport),
    ['local'],
  );
});

test('no UDP answer: the board id of the first frame identifies the printer', async (t) => {
  const printer = new FakePrinter({ id: FDM_ID, model: 'Centauri Carbon', status: fdmStatus() });
  const { gladys, sockets } = await setup(t, {
    printers: { '192.168.1.50': printer },
    answerProbe: false,
  });
  assert.equal(gladys.fake.discoveredDevices.length, 0, 'nothing known yet');
  assert.equal(sockets.length, 1);
  printer.pushStatus();
  await settle();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id(FDM_ID));
  assert.ok(device.features.some((f) => f.external_id === id(FDM_ID, 'nozzle-temperature')));
  assert.ok(printer.commands().includes(CMD.ATTRIBUTES), 'asked once identified');
});

test('scene triggers: paused, finished (once per job), error; only on changes', async (t) => {
  const { gladys, printers } = await setup(t);
  await createAll(gladys);
  const printer = printers['192.168.1.50'];
  printer.pushStatus({ PrintInfo: { Status: 6 } });
  printer.pushStatus({ PrintInfo: { Status: 3 } });
  printer.pushStatus({ CurrentStatus: [0], PrintInfo: { Status: 9 } });
  printer.pushStatus({ CurrentStatus: [1], PrintInfo: { Status: 3 } });
  printer.pushStatus({ CurrentStatus: [0], PrintInfo: { Status: 9 } });
  printer.pushStatus({ CurrentStatus: [1], PrintInfo: { Status: 3, ErrorNumber: 2 } });
  await settle();
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => e.key),
    ['print_paused', 'print_finished', 'print_error'],
  );
  const [paused, , error] = gladys.fake.sceneEvents;
  assert.deepEqual(paused.data, { device: id(RESIN_ID), file: 'benchy.ctb' });
  assert.equal(error.data.error_code, 2);
  assert.equal(error.data.error, 'Lecture du fichier échouée');
  // An error frame.
  printer.push({
    Id: printer.connectionId,
    Data: { Data: { ErrorCode: '1' }, MainboardID: RESIN_ID, TimeStamp: 1 },
    Topic: `sdcp/error/${RESIN_ID}`,
  });
  await settle();
  assert.equal(gladys.fake.sceneEvents.at(-1).data.error_code, 1);
});

test('a reconnection: the first status is a baseline, nothing fires', async (t) => {
  const { gladys, clock, sockets, printers } = await setup(t);
  await createAll(gladys);
  const printer = printers['192.168.1.50'];
  sockets[0].drop();
  await settle();
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  printer.status = { ...printer.status, PrintInfo: { ...printer.status.PrintInfo, Status: 6 } };
  await clock.advance(TIMINGS.backoff[0]);
  await settle();
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  assert.deepEqual(gladys.fake.sceneEvents, [], 'paused while away: no event');
});

test('print control: off by default, nothing sent', async (t) => {
  const { gladys, printers } = await setup(t);
  await createAll(gladys);
  const ack = await gladys.fake.sceneAction('print_control', {
    device: id(RESIN_ID),
    command: 'pause',
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /désactivé/);
  assert.ok(!printers['192.168.1.50'].commands().includes(CMD.PAUSE));
});

test('print control allowed: fresh state first, then the command and its ack', async (t) => {
  const { gladys, printers } = await setup(t, {
    config: { addresses: '192.168.1.50', allow_print_control: true, language: 'en' },
  });
  await createAll(gladys);
  const printer = printers['192.168.1.50'];
  const before = printer.commands().length;
  const ack = await gladys.fake.sceneAction('print_control', {
    device: id(RESIN_ID),
    command: 'pause',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(printer.commands().slice(before, before + 2), [CMD.STATUS, CMD.PAUSE]);
  // Resume while printing: refused before acting.
  const resume = await gladys.fake.sceneAction('print_control', {
    device: id(RESIN_ID),
    command: 'resume',
  });
  assert.equal(resume.success, false);
  assert.match(resume.error, /"Printing": no resume possible/);
  assert.ok(!printer.commands().includes(CMD.RESUME));
  // Refused by the printer.
  printer.acks[CMD.STOP] = 1;
  const stop = await gladys.fake.sceneAction('print_control', {
    device: id(RESIN_ID),
    command: 'stop',
  });
  assert.equal(stop.success, false);
  assert.match(stop.error, /busy/);
  // Unknown command, unknown device.
  assert.equal(
    (await gladys.fake.sceneAction('print_control', { device: id(RESIN_ID), command: 'start' }))
      .success,
    false,
  );
  assert.equal(
    (await gladys.fake.sceneAction('print_control', { device: 'x', command: 'stop' })).success,
    false,
  );
});

test('print control: no fresh state, no command', async (t) => {
  const { gladys, clock, printers, app } = await setup(t, {
    config: { addresses: '192.168.1.50', allow_print_control: true, language: 'en' },
  });
  await createAll(gladys);
  const printer = printers['192.168.1.50'];
  printer.silent = true;
  const pending = app.control({ device: id(RESIN_ID), command: 'stop' });
  pending.catch(() => {});
  await settle();
  await clock.advance(TIMINGS.freshStatus);
  await assert.rejects(pending, /did not send a fresh state/);
  assert.ok(!printer.commands().includes(CMD.STOP));
});

test('print control: no answer to the command is reported as such', async (t) => {
  const { gladys, clock, printers, app } = await setup(t, {
    config: { addresses: '192.168.1.50', allow_print_control: true, language: 'en' },
  });
  await createAll(gladys);
  const printer = printers['192.168.1.50'];
  const original = printer.received.bind(printer);
  printer.received = (text) => {
    if (text !== 'ping' && JSON.parse(text).Data.Cmd === CMD.STOP) {
      printer.requests.push(JSON.parse(text));
      return;
    }
    original(text);
  };
  const pending = app.control({ device: id(RESIN_ID), command: 'stop' });
  pending.catch(() => {});
  await settle();
  await clock.advance(TIMINGS.commandAck);
  await assert.rejects(pending, /did not confirm the command in time/);
});

test('print control: an offline printer gets nothing', async (t) => {
  const { gladys, sockets, app } = await setup(t, {
    config: { addresses: '192.168.1.50', allow_print_control: true, language: 'en' },
  });
  await createAll(gladys);
  sockets[0].drop();
  await assert.rejects(app.control({ device: id(RESIN_ID), command: 'pause' }), /not connected/);
});

test('"Find the printers": the SDCP broadcast through the core', async (t) => {
  const found = new FakePrinter({
    id: FDM_ID,
    name: 'CC',
    model: 'Centauri Carbon',
    ip: '192.168.1.60',
    status: fdmStatus(),
  });
  const { gladys, probes } = await setup(t, {
    config: {},
    printers: { '192.168.1.60': found },
    scanResults: {
      'udp-active-broadcast': [
        {
          source_ip: '192.168.1.60',
          source_port: 3000,
          payload_base64: Buffer.from(found.discoveryReply()).toString('base64'),
        },
        {
          source_ip: '192.168.1.61',
          source_port: 3000,
          payload_base64: Buffer.from('garbage').toString('base64'),
        },
      ],
    },
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  const ack = await gladys.fake.action('find_printers');
  assert.match(ack.data.message.en, /CC \(Centauri Carbon\) 192\.168\.1\.60/);
  const [scan] = gladys.fake.scans;
  assert.equal(scan.type, 'udp-active-broadcast');
  assert.equal(scan.port, 3000);
  assert.equal(Buffer.from(scan.payload_base64, 'base64').toString(), 'M99999');
  await settle();
  assert.deepEqual(probes, [], 'identified by the search');
  assert.equal(gladys.fake.discoveredDevices[0].external_id, id(FDM_ID));
});

test('known printers are kept in /data; a deleted device is forgotten', async (t) => {
  const store = new MemoryStore();
  const first = await setup(t, { store });
  await first.app.stop();
  assert.ok(store.data.printers[RESIN_ID]);
  assert.equal(store.data.printers[RESIN_ID].type, 'resin');
  const second = await setup(t, { store, answerProbe: false });
  assert.deepEqual(second.probes, [], 'known: no probe');
  await createAll(second.gladys);
  await second.gladys.fake.configUpdated({ addresses: '' });
  await settle();
  assert.equal(
    second.sockets.filter((s) => !s.closed).length,
    1,
    'a created device stays connected',
  );
  await second.gladys.fake.deviceDeleted(second.gladys.fake.devices[0]);
  await second.clock.advance(TIMINGS.persistDelay);
  assert.equal(store.data.printers[RESIN_ID], undefined);
  assert.equal(second.sockets.filter((s) => !s.closed).length, 0);
});

test('another printer at a known address takes it over', async (t) => {
  const store = new MemoryStore();
  const first = await setup(t, { store });
  await first.app.stop();
  const other = new FakePrinter({ id: FDM_ID, model: 'Centauri Carbon', status: fdmStatus() });
  const { gladys, logs } = await setup(t, { store, printers: { '192.168.1.50': other } });
  other.pushStatus();
  await settle();
  assert.ok(logs.some((l) => /frames of board/.test(l)));
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id === id(FDM_ID)));
});
