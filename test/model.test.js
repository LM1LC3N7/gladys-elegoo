import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseAddresses, parseHost } from '../src/config.js';
import { SCENE_TRIGGERS } from '../src/constants.js';
import { jobEvents } from '../src/events.js';
import { buildDevice, capsOf, featureKeys, mergeCaps, statusValues } from '../src/model.js';
import { parseStatus } from '../src/sdcp/protocol.js';
import { FDM_ID, RESIN_ID, fdmStatus, resinStatus } from './helpers/fakes.js';

/**
 * The units the Gladys core accepts per category (DEVICE_FEATURE_UNITS_BY_CATEGORY
 * of server/utils/constants.js) for the categories used here; `text` and
 * `unknown` take none.
 */
const CORE_UNITS = {
  'device-temperature-sensor': ['celsius', 'fahrenheit'],
  duration: [
    'microseconds',
    'milliseconds',
    'seconds',
    'minutes',
    'hours',
    'days',
    'weeks',
    'months',
    'years',
  ],
  fan: ['percent'],
  text: [],
  unknown: [],
};

const gladys = createFakeGladys({ selector: 'elegoo' });
const fdm = { id: FDM_ID, model: 'Centauri Carbon', type: 'fdm', address: '192.168.1.51' };
const resin = { id: RESIN_ID, model: 'Saturn 4 Ultra', type: 'resin', address: '192.168.1.50' };

test('features: the common ones, plus what the printer reports', () => {
  const fdmCaps = capsOf(parseStatus({ Status: fdmStatus() }, 'fdm'), 'fdm');
  assert.deepEqual(fdmCaps, [
    'nozzle-temperature',
    'bed-temperature',
    'enclosure-temperature',
    'model-fan',
    'auxiliary-fan',
    'enclosure-fan',
  ]);
  // A resin printer reports TempOfBox 0 without a sensor: not a feature.
  const resinCaps = capsOf(parseStatus({ Status: resinStatus() }, 'resin'), 'resin');
  assert.deepEqual(resinCaps, ['uvled-temperature']);
  assert.deepEqual(mergeCaps(['vat-temperature'], resinCaps), [
    'uvled-temperature',
    'vat-temperature',
  ]);
  const device = buildDevice(gladys, { ...fdm, caps: fdmCaps }, 'en');
  assert.equal(device.external_id, `ext:elegoo:printer:${FDM_ID}`);
  assert.equal(device.name, 'Elegoo Centauri Carbon');
  assert.equal(device.features.length, 16);
  assert.ok(device.features.every((f) => f.read_only === true));
  assert.equal(featureKeys({ ...resin, caps: resinCaps }).length, 11);
});

test('units: only the ones the core lists for the category', () => {
  const caps = mergeCaps(capsOf(parseStatus({ Status: fdmStatus() }, 'fdm'), 'fdm'), [
    'uvled-temperature',
    'vat-temperature',
  ]);
  for (const feature of buildDevice(gladys, { ...fdm, caps }).features) {
    const allowed = CORE_UNITS[feature.category];
    assert.ok(allowed, `${feature.external_id}: category ${feature.category}`);
    if (feature.unit !== undefined) {
      assert.ok(allowed.includes(feature.unit), `${feature.external_id}: ${feature.unit}`);
    }
    assert.ok(feature.min <= feature.max);
  }
});

test('states: texts in the chosen language, minutes, errors', () => {
  const record = { ...resin, caps: ['uvled-temperature'] };
  const values = statusValues(record, parseStatus({ Status: resinStatus() }, 'resin'), 'fr');
  assert.deepEqual(values.get('state'), { text: 'Impression' });
  assert.deepEqual(values.get('progress'), { state: 25 });
  assert.deepEqual(values.get('elapsed'), { state: 30 });
  assert.deepEqual(values.get('remaining'), { state: 90 });
  assert.deepEqual(values.get('file'), { text: 'benchy.ctb' });
  assert.deepEqual(values.get('error'), { text: 'Aucune' });
  assert.deepEqual(values.get('error-code'), { state: 0 });
  assert.deepEqual(values.get('uvled-temperature'), { state: 31.2 });
  assert.equal(values.has('nozzle-temperature'), false);
  const failed = statusValues(
    record,
    parseStatus({ Status: resinStatus({ PrintInfo: { ErrorNumber: 4 } }) }, 'resin'),
    'en',
  );
  assert.deepEqual(failed.get('state'), { text: 'Error' });
  assert.deepEqual(failed.get('error'), { text: 'Unknown file format' });
  assert.deepEqual(failed.get('error-code'), { state: 4 });
  const frame = statusValues(record, parseStatus({ Status: resinStatus() }, 'resin'), 'en', {
    code: 1,
  });
  assert.deepEqual(frame.get('error'), { text: 'File transfer check (MD5) failed' });
  const noFile = statusValues(
    record,
    parseStatus({ Status: resinStatus({ PrintInfo: { Filename: '' } }) }, 'resin'),
  );
  assert.deepEqual(noFile.get('file'), { text: '-' }, 'Gladys refuses an empty text');
});

test('events: finished, error, paused, only on a change', () => {
  const status = (patch, type = 'fdm') => parseStatus({ Status: fdmStatus(patch) }, type);
  const printing = status();
  assert.deepEqual(jobEvents(undefined, printing), [], 'a baseline fires nothing');
  assert.deepEqual(jobEvents(printing, status({ PrintInfo: { Status: 6 } })), [
    SCENE_TRIGGERS.PAUSED,
  ]);
  assert.deepEqual(
    jobEvents(status({ PrintInfo: { Status: 6 } }), status({ PrintInfo: { Status: 6 } })),
    [],
  );
  const done = status({ CurrentStatus: [0], PrintInfo: { Status: 9 } });
  assert.deepEqual(jobEvents(printing, done), [SCENE_TRIGGERS.FINISHED]);
  assert.deepEqual(jobEvents(done, done), []);
  const idle = status({ CurrentStatus: [0], PrintInfo: { Status: 0 } });
  assert.deepEqual(jobEvents(idle, done), [], 'completed seen from idle: not a job of ours');
  assert.deepEqual(jobEvents(printing, status({ PrintInfo: { Status: 14 } })), [
    SCENE_TRIGGERS.ERROR,
  ]);
  const errorNumber = status({ PrintInfo: { ErrorNumber: 2 } });
  assert.deepEqual(jobEvents(printing, errorNumber), [SCENE_TRIGGERS.ERROR]);
  assert.deepEqual(jobEvents(errorNumber, errorNumber), []);
});

test('configuration: addresses, bounds, the control off by default', () => {
  assert.equal(parseHost('ws://192.168.1.50:3030/websocket'), '192.168.1.50');
  assert.equal(parseHost('Printer.LAN'), 'printer.lan');
  assert.equal(parseHost('300.1.1.1'), undefined);
  assert.equal(parseHost('bad_host!'), undefined);
  assert.deepEqual(parseAddresses('192.168.1.50, 192.168.1.50;bad_host! 10.0.0.2'), {
    valid: ['192.168.1.50', '10.0.0.2'],
    invalid: ['bad_host!'],
  });
  const defaults = normalizeConfig({});
  assert.equal(defaults.allowPrintControl, false);
  assert.equal(defaults.refreshInterval, 30);
  assert.equal(defaults.language, 'fr');
  assert.equal(normalizeConfig({ refresh_interval: 1 }).refreshInterval, 10);
  assert.equal(normalizeConfig({ refresh_interval: 'x' }).refreshInterval, 30);
  assert.equal(normalizeConfig({ allow_print_control: 'false' }).allowPrintControl, false);
  assert.equal(normalizeConfig({ allow_print_control: true }).allowPrintControl, true);
});
