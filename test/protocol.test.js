import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest,
  parseAttributes,
  parseDiscovery,
  parseErrorFrame,
  parseMessage,
  parseResponse,
  parseStatus,
  phaseOf,
  printerTypeOf,
} from '../src/sdcp/protocol.js';
import { FDM_ID, FakePrinter, RESIN_ID, fdmStatus, resinStatus } from './helpers/fakes.js';

test('messages: pong, frames, and what is refused', () => {
  assert.deepEqual(parseMessage('pong'), { kind: 'pong' });
  const frame = new FakePrinter().statusFrame();
  const parsed = parseMessage(JSON.stringify(frame));
  assert.equal(parsed.kind, 'status');
  assert.equal(parsed.mainboardId, RESIN_ID);
  for (const [text, reason] of [
    ['{not json', 'not JSON'],
    ['[]', 'no topic'],
    ['{"Topic": 3}', 'no topic'],
    ['{"Topic": "sdcp/request/abc"}', 'unknown topic'],
    ['{"Topic": "sdcp/status/../x"}', 'unknown topic'],
    [JSON.stringify({ ...frame, MainboardID: 'other' }), 'board id mismatch'],
    [
      JSON.stringify({ Topic: `sdcp/response/${RESIN_ID}`, Data: { MainboardID: 'x' } }),
      'board id mismatch',
    ],
    ['x'.repeat(256 * 1024 + 1), 'message too large'],
  ]) {
    assert.deepEqual(parseMessage(text), { kind: 'invalid', reason }, text.slice(0, 40));
  }
  assert.equal(parseMessage(Buffer.from('pong')).kind, 'invalid', 'texts only');
});

test('the request frame follows SDCP', () => {
  const text = buildRequest({
    cmd: 129,
    mainboardId: RESIN_ID,
    connectionId: 'abc',
    requestId: '0011223344556677',
    now: 1_687_069_655_123,
  });
  assert.deepEqual(JSON.parse(text), {
    Id: 'abc',
    Data: {
      Cmd: 129,
      Data: {},
      RequestID: '0011223344556677',
      MainboardID: RESIN_ID,
      TimeStamp: 1_687_069_655,
      From: 0,
    },
    Topic: `sdcp/request/${RESIN_ID}`,
  });
});

test('discovery and attributes: the identity, validated', () => {
  const printer = new FakePrinter();
  assert.deepEqual(parseDiscovery(Buffer.from(printer.discoveryReply())), printer.identity());
  assert.equal(parseDiscovery('M99999'), undefined);
  assert.equal(parseDiscovery(JSON.stringify({ Data: { MainboardID: '../x' } })), undefined);
  assert.equal(parseDiscovery('x'.repeat(5000)), undefined);
  const identity = parseAttributes(printer.attributesFrame());
  assert.equal(identity.mainboardId, RESIN_ID);
  assert.equal(identity.model, 'ELEGOO Saturn 4 Ultra');
  const dirty = parseDiscovery(
    JSON.stringify({ Id: 'x', Data: { MainboardID: 'ab', Name: 'Bad\u0000\u001bname' } }),
  );
  assert.equal(dirty.name, 'Badname', 'control characters removed');
});

test('responses and error frames', () => {
  assert.deepEqual(parseResponse({ Data: { Cmd: 129, Data: { Ack: 1 }, RequestID: 'r1' } }), {
    cmd: 129,
    requestId: 'r1',
    ack: 1,
  });
  assert.equal(parseResponse({ Data: { Cmd: 1 } }), undefined);
  assert.deepEqual(parseErrorFrame({ Data: { Data: { ErrorCode: '2' } } }), { code: 2 });
  assert.deepEqual(parseErrorFrame({ Data: { Data: { ErrorCode: 'abc' } } }), { code: -1 });
});

test('printer type from the model', () => {
  assert.equal(printerTypeOf('ELEGOO Centauri Carbon'), 'fdm');
  assert.equal(printerTypeOf('Saturn 3 Ultra'), 'resin');
  assert.equal(printerTypeOf('Mars 5 Ultra'), 'resin');
  assert.equal(printerTypeOf('Something'), undefined);
});

test('resin status: milliseconds, progress from the layers', () => {
  const status = parseStatus({ Status: resinStatus() }, 'resin');
  assert.equal(status.phase, 'printing');
  assert.equal(status.machine, 'printing');
  assert.equal(status.progress, 25);
  assert.equal(status.layer, 250);
  assert.equal(status.totalLayers, 1000);
  assert.equal(status.elapsedMs, 1_800_000);
  assert.equal(status.remainingMs, 5_400_000);
  assert.equal(status.file, 'benchy.ctb');
  assert.equal(status.temperatures.uvled, 31.2);
  assert.equal(status.temperatures.enclosure, 0);
  assert.equal(status.temperatures.nozzle, undefined);
  assert.equal(status.fans.model, undefined);
});

test('FDM status: seconds, reported progress, temperatures and fans', () => {
  const status = parseStatus({ Status: fdmStatus() }, 'fdm');
  assert.equal(status.phase, 'printing');
  assert.equal(status.progress, 33);
  assert.equal(status.elapsedMs, 1_200_000);
  assert.equal(status.remainingMs, 2_400_000);
  assert.deepEqual(status.temperatures, {
    nozzle: 219.6,
    bed: 60,
    enclosure: 32.5,
    uvled: undefined,
    vat: undefined,
  });
  assert.deepEqual(status.fans, { model: 100, auxiliary: 30, enclosure: 0 });
  // Also nested under Data (the MQTT shape).
  assert.equal(parseStatus({ Data: { Status: fdmStatus() } }, 'fdm').phase, 'printing');
  assert.equal(parseStatus({ Data: {} }, 'fdm'), undefined);
  assert.equal(parseStatus({ Status: {} }, 'fdm'), undefined);
});

test('hostile numbers are dropped, not clamped', () => {
  const status = parseStatus(
    {
      Status: fdmStatus({
        TempOfNozzle: 9999,
        TempOfHotbed: 'hot',
        CurrentFanSpeed: { ModelFan: -5 },
        PrintInfo: { CurrentTicks: 1e12, CurrentLayer: Number.NaN, Progress: 400, TotalLayer: 0 },
      }),
    },
    'fdm',
  );
  assert.equal(status.temperatures.nozzle, undefined);
  assert.equal(status.temperatures.bed, undefined);
  assert.equal(status.fans.model, undefined);
  assert.equal(status.elapsedMs, undefined);
  assert.equal(status.remainingMs, undefined);
  assert.equal(status.layer, undefined);
  assert.equal(status.progress, undefined);
});

test('phases: machine status and print sub-status together', () => {
  // Resin.
  assert.equal(phaseOf('resin', 1, 6), 'paused');
  assert.equal(phaseOf('resin', 1, 5), 'pausing');
  assert.equal(phaseOf('resin', 1, 1), 'preparing');
  assert.equal(phaseOf('resin', 1, 0), 'preparing', 'printing, sub-status not there yet');
  assert.equal(phaseOf('resin', 0, 9), 'completed', 'the sub-status keeps the end of the job');
  assert.equal(phaseOf('resin', 0, 8), 'stopped');
  assert.equal(phaseOf('resin', 0, 3), 'idle', 'an active sub-status while idle is stale');
  assert.equal(phaseOf('resin', 2, 0), 'busy', 'file transfer');
  assert.equal(phaseOf('resin', 1, 3, 4), 'error', 'ErrorNumber');
  assert.equal(phaseOf('resin', 1, 77), 'preparing', 'unknown code while printing');
  // FDM (Centauri Carbon table).
  assert.equal(phaseOf('fdm', 1, 13), 'printing');
  assert.equal(phaseOf('fdm', 1, 20), 'printing', 'parked on "preheating completed"');
  assert.equal(phaseOf('fdm', 1, 16), 'preparing', 'preheating');
  assert.equal(phaseOf('fdm', 1, 14), 'error');
  assert.equal(phaseOf('fdm', 1, 6), 'paused');
  assert.equal(phaseOf('fdm', 1, 99), 'printing');
  assert.equal(phaseOf('fdm', 0, 9), 'completed');
  assert.equal(phaseOf(undefined, undefined, undefined), 'unknown');
  const idle = parseStatus(
    { Status: fdmStatus({ CurrentStatus: [0], PrintInfo: { Status: 0 } }) },
    'fdm',
  );
  assert.equal(idle.progress, 0);
  const done = parseStatus(
    { Status: fdmStatus({ CurrentStatus: [0], PrintInfo: { Status: 9, Progress: 99 } }) },
    'fdm',
  );
  assert.equal(done.progress, 100);
  assert.equal(
    parseStatus({ Status: { CurrentStatus: 1 } }, 'fdm').machine,
    'printing',
    'a number',
  );
  assert.equal(FDM_ID.length, 16);
});
