// -----------------------------------------------------------------------------
// Known printers -> Gladys devices and states (pure).
//
// External ids (forever): `gladys.externalIds('printer', <MainboardID>)`, the
// board id the printer gives in its SDCP frames, whatever its address or
// name. Feature keys are frozen (the FEATURES list below).
//
// Every feature is read-only: the only commands (pause, resume, stop) are a
// scene action, off by default (src/app.js).
//
// Units: only the ones the Gladys core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C for the device temperatures, minutes
// for the durations, % for the fans; the progress, an `unknown` integer,
// carries none (its name says "%").
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  FEATURE_NAMES,
  MACHINE_NAMES,
  PHASE_NAMES,
  frameErrorText,
  printErrorText,
  word,
} from './i18n.js';

export const EXTERNAL_ID_TYPE = 'printer';

const text = { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false };
const integer = (max) => ({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max });
const minutes = {
  category: C.DURATION,
  type: T.DURATION.INTEGER,
  unit: U.MINUTES,
  min: 0,
  max: 43_200,
};
const temperature = (max) => ({
  category: C.DEVICE_TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -40,
  max,
  measure: true,
});
const fan = {
  category: C.FAN,
  type: T.FAN.PERCENT,
  unit: U.PERCENT,
  min: 0,
  max: 100,
  measure: true,
};

/** Feature key -> spec. The keys are frozen: they end the feature external ids. */
export const SPECS = {
  state: text,
  machine: text,
  progress: integer(100),
  layer: integer(1_000_000),
  'total-layers': integer(1_000_000),
  elapsed: minutes,
  remaining: minutes,
  file: text,
  error: text,
  // -1: an error without a number (an FDM error status).
  'error-code': { ...integer(1_000_000), min: -1 },
  'nozzle-temperature': temperature(400),
  'bed-temperature': temperature(200),
  'enclosure-temperature': temperature(150),
  'uvled-temperature': temperature(150),
  'vat-temperature': temperature(150),
  'model-fan': fan,
  'auxiliary-fan': fan,
  'enclosure-fan': fan,
};

const COMMON = [
  'state',
  'machine',
  'progress',
  'layer',
  'total-layers',
  'elapsed',
  'remaining',
  'file',
  'error',
  'error-code',
];

/** Status field (src/sdcp/protocol.js) of each optional feature. */
const OPTIONAL = {
  'nozzle-temperature': ['temperatures', 'nozzle'],
  'bed-temperature': ['temperatures', 'bed'],
  'enclosure-temperature': ['temperatures', 'enclosure'],
  'uvled-temperature': ['temperatures', 'uvled'],
  'vat-temperature': ['temperatures', 'vat'],
  'model-fan': ['fans', 'model'],
  'auxiliary-fan': ['fans', 'auxiliary'],
  'enclosure-fan': ['fans', 'enclosure'],
};

/**
 * The optional features a status shows. A resin printer reports some
 * temperatures as a constant 0 when it has no such sensor: there, only a
 * value seen non-zero once counts.
 */
export function capsOf(status, type) {
  const caps = [];
  for (const [key, [group, field]] of Object.entries(OPTIONAL)) {
    const value = status?.[group]?.[field];
    if (value !== undefined && (type === 'fdm' || group === 'fans' || value !== 0)) {
      caps.push(key);
    }
  }
  return caps;
}

/** The capabilities only grow: a status missing a field once never removes a feature. */
export const mergeCaps = (previous = [], next = []) =>
  Object.keys(OPTIONAL).filter((key) => previous.includes(key) || next.includes(key));

export const featureKeys = (record) => [
  ...COMMON,
  ...Object.keys(OPTIONAL).filter((key) => record.caps?.includes(key)),
];

export function deviceName(record) {
  const name = record.name || `Elegoo ${record.model || 'printer'}`;
  return name.slice(0, 100);
}

/** The Gladys device of a known printer. */
export function buildDevice(gladys, record, language = 'fr') {
  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, record.id);
  const features = featureKeys(record).map((key) => {
    const { measure, ...spec } = SPECS[key];
    void measure;
    return {
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...spec,
    };
  });
  const params = [
    { name: 'IP_ADDRESS', value: record.address ?? '' },
    { name: 'MAINBOARD_ID', value: record.id },
    { name: 'MODEL', value: record.model ?? '' },
    { name: 'FIRMWARE', value: record.firmware ?? '' },
    { name: 'PRINTER_TYPE', value: record.type ?? '' },
  ].filter((param) => param.value !== '');
  return {
    name: deviceName(record),
    external_id: ids.device,
    features,
    params,
    should_poll: false,
  };
}

/**
 * featureKey -> `{ state }` or `{ text }` from a normalized status (and the
 * last error frame, `{ code }`, until a new job starts).
 */
export function statusValues(record, status, language = 'fr', frameError) {
  const values = new Map();
  const keys = new Set(featureKeys(record));
  const set = (key, value) => {
    if (value !== undefined && keys.has(key)) {
      values.set(key, typeof value === 'string' ? { text: value } : { state: value });
    }
  };
  set('state', word(PHASE_NAMES[status.phase] ?? PHASE_NAMES.unknown, language));
  if (status.machine) {
    set('machine', word(MACHINE_NAMES[status.machine] ?? MACHINE_NAMES.unknown, language));
  }
  set('progress', status.progress);
  set('layer', status.layer);
  set('total-layers', status.totalLayers);
  set(
    'elapsed',
    status.elapsedMs === undefined ? undefined : Math.floor(status.elapsedMs / 60_000),
  );
  set(
    'remaining',
    status.remainingMs === undefined ? undefined : Math.ceil(status.remainingMs / 60_000),
  );
  // An empty text is refused by Gladys: no file is "-".
  set('file', status.file ?? '-');
  const errorNumber = status.errorNumber ?? 0;
  if (errorNumber > 0 || status.phase === 'error' || !frameError) {
    set('error', word(printErrorText(errorNumber, status.phase), language));
    set('error-code', errorNumber > 0 ? errorNumber : status.phase === 'error' ? -1 : 0);
  } else {
    set('error', word(frameErrorText(frameError.code), language));
    set('error-code', frameError.code);
  }
  for (const [key, [group, field]] of Object.entries(OPTIONAL)) {
    set(key, status[group]?.[field]);
  }
  return values;
}

/** The feature keys whose states are measures (spaced by the publisher). */
export const isMeasure = (key) => Boolean(SPECS[key]?.measure);
