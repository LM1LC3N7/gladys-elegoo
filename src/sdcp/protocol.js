// -----------------------------------------------------------------------------
// SDCP V3 messages (pure): what the printer sends, validated and normalized,
// and the requests sent to it.
//
// Sources: Elegoo's public protocol (cbd-tech/SDCP-Smart-Device-Control-
// Protocol-V3.0.0) for the frames, topics, commands and the resin status
// tables; danielcherubini/elegoo-homeassistant (MIT) for what the FDM
// firmware (Centauri Carbon) does differently: its print status table, its
// times in seconds instead of milliseconds, its nozzle / bed / fan fields.
//
// Nothing from the network is trusted: a message is a bounded text, parsed
// as JSON, whose topic, board id and every field are checked; a number out of
// its range is dropped, never clamped into a plausible value.
// -----------------------------------------------------------------------------

import { LIMITS, SDCP } from '../constants.js';

const TOPIC = /^sdcp\/(status|attributes|response|error|notice)\/([0-9A-Za-z]{1,64})$/;
const BOARD_ID = /^[0-9A-Za-z]{1,64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A finite number within [min, max], else undefined. */
export function num(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

/** A printable text, without control characters, bounded. */
export function str(value, max = LIMITS.text) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text === '' ? undefined : text.slice(0, max);
}

const round1 = (value) => (value === undefined ? undefined : Math.round(value * 10) / 10);

/**
 * One message of the WebSocket.
 * @returns {{ kind: 'pong' } | { kind: string, mainboardId: string, body: object } | { kind: 'invalid', reason: string }}
 */
export function parseMessage(text) {
  if (typeof text !== 'string') {
    return { kind: 'invalid', reason: 'not a text message' };
  }
  if (text.length > LIMITS.messageBytes) {
    return { kind: 'invalid', reason: 'message too large' };
  }
  if (text.trim() === SDCP.pong) {
    return { kind: 'pong' };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isObject(body) || typeof body.Topic !== 'string') {
    return { kind: 'invalid', reason: 'no topic' };
  }
  const match = TOPIC.exec(body.Topic);
  if (!match) {
    return { kind: 'invalid', reason: 'unknown topic' };
  }
  const [, kind, mainboardId] = match;
  // The board id also appears in the frame (top level, or under Data): it must agree.
  for (const id of [body.MainboardID, body.Data?.MainboardID]) {
    if (id !== undefined && id !== mainboardId) {
      return { kind: 'invalid', reason: 'board id mismatch' };
    }
  }
  return { kind, mainboardId, body };
}

/** The JSON text of a request (`Id` is the brand id of the discovery answer, '' when unknown). */
export function buildRequest({ cmd, data = {}, mainboardId, connectionId = '', requestId, now }) {
  return JSON.stringify({
    Id: connectionId,
    Data: {
      Cmd: cmd,
      Data: data,
      RequestID: requestId,
      MainboardID: mainboardId,
      TimeStamp: Math.floor(now / 1000),
      From: SDCP.from,
    },
    Topic: `sdcp/request/${mainboardId}`,
  });
}

/** 'fdm', 'resin' or undefined, from the machine model (as elegoo-homeassistant). */
export function printerTypeOf(model) {
  const text = String(model ?? '').toLowerCase();
  if (/centauri|neptune/.test(text)) {
    return 'fdm';
  }
  if (/saturn|mars|jupiter/.test(text)) {
    return 'resin';
  }
  return undefined;
}

/**
 * The answer to "M99999" (UDP), or the identity fields of an attributes
 * frame: `{ mainboardId, connectionId, name, model, brand, firmware, protocol, ip }`.
 */
export function parseIdentity(fields, connectionId) {
  if (!isObject(fields)) {
    return undefined;
  }
  const mainboardId = typeof fields.MainboardID === 'string' ? fields.MainboardID : '';
  if (!BOARD_ID.test(mainboardId)) {
    return undefined;
  }
  return {
    mainboardId,
    connectionId: str(connectionId, 64) ?? '',
    name: str(fields.Name, 100) ?? '',
    model: str(fields.MachineName, 100) ?? '',
    brand: str(fields.BrandName, 50) ?? '',
    firmware: str(fields.FirmwareVersion, 50) ?? '',
    protocol: str(fields.ProtocolVersion, 20) ?? '',
    ip: str(fields.MainboardIP, 45) ?? '',
  };
}

/** A UDP discovery datagram (Buffer or text) -> identity, or undefined. */
export function parseDiscovery(datagram) {
  const text = Buffer.isBuffer(datagram) ? datagram.toString('utf8') : String(datagram ?? '');
  if (text.length === 0 || text.length > LIMITS.datagramBytes) {
    return undefined;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(body) || !isObject(body.Data)) {
    return undefined;
  }
  return parseIdentity(body.Data, body.Id);
}

/** The attributes frame -> identity, or undefined. */
export function parseAttributes(body) {
  const attributes = body?.Attributes ?? body?.Data?.Attributes;
  return parseIdentity(attributes, body?.Id);
}

/** The response frame -> `{ cmd, requestId, ack }`, or undefined. */
export function parseResponse(body) {
  const data = body?.Data;
  if (!isObject(data) || typeof data.RequestID !== 'string') {
    return undefined;
  }
  const inner = isObject(data.Data) ? data.Data : {};
  return {
    cmd: num(data.Cmd, 0, 65535),
    requestId: data.RequestID.slice(0, 64),
    ack: Number.isInteger(inner.Ack) ? inner.Ack : undefined,
  };
}

/** The error frame -> its code (SDCP: 1 MD5 check failed, 2 wrong file format). */
export function parseErrorFrame(body) {
  const code = body?.Data?.Data?.ErrorCode;
  const number = typeof code === 'string' && /^\d{1,6}$/.test(code) ? Number(code) : code;
  return { code: Number.isInteger(number) ? number : -1 };
}

// --- Status -------------------------------------------------------------------

/** Machine status (CurrentStatus): the SDCP table and what the FDM firmware adds. */
export const MACHINE = {
  0: 'idle',
  1: 'printing',
  2: 'file_transfer',
  3: 'exposure_test',
  4: 'self_test',
  5: 'leveling',
  6: 'input_shaping',
  7: 'stopping',
  8: 'stopped',
  9: 'homing',
  10: 'loading',
  11: 'pid_tuning',
  12: 'recovery',
};

/** Resin print sub-status (PrintInfo.Status): SDCP, plus the codes seen by elegoo-homeassistant. */
const RESIN_PHASE = {
  0: 'idle',
  1: 'preparing', // homing
  2: 'printing', // dropping
  3: 'printing', // exposing
  4: 'printing', // lifting
  5: 'pausing',
  6: 'paused',
  7: 'stopping',
  8: 'stopped',
  9: 'completed',
  10: 'preparing', // file checking
  12: 'preparing', // recovery
  13: 'printing', // printing (recovery)
  15: 'preparing', // loading
  16: 'preparing', // preheating
  18: 'preparing', // loading
  19: 'preparing', // loading
  20: 'preparing', // leveling
  21: 'preparing', // loading
};

/**
 * FDM print sub-status (Centauri Carbon), after elegoo-homeassistant (which
 * follows Elegoo's own elegoo-link adapter). The firmware parks on milestones
 * ("preheating completed") for the whole job: the machine status says whether
 * it prints.
 */
const FDM_PHASE = {
  0: 'idle',
  1: 'preparing', // homing
  2: 'printing',
  4: 'printing',
  5: 'pausing',
  6: 'paused',
  7: 'stopping',
  8: 'stopped',
  9: 'completed',
  10: 'preparing', // file checking
  11: 'preparing', // printer checking
  12: 'printing', // resuming
  13: 'printing',
  14: 'error',
  15: 'preparing', // auto leveling
  16: 'preparing', // preheating
  17: 'preparing', // resonance testing
  18: 'preparing', // print started
  19: 'preparing', // auto leveling completed
  20: 'preparing', // preheating completed
  21: 'preparing', // homing completed
  22: 'preparing', // resonance testing completed
  23: 'preparing', // auto feeding
  24: 'preparing', // filament unloading
  25: 'error', // filament unload abnormal
  26: 'paused', // filament unload paused
};

/** FDM "... completed" milestones the firmware keeps while it prints. */
const FDM_MILESTONES = new Set([18, 19, 20, 21, 22]);

/** The phases of a job in progress (a pause included). */
export const ACTIVE_PHASES = new Set(['preparing', 'printing', 'pausing', 'paused', 'stopping']);

/** The phases the user sees, in order (the text feature and the docs use the same list). */
export const PHASES = [
  'idle',
  'preparing',
  'printing',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'completed',
  'error',
  'busy',
  'unknown',
];

/** The machine status code: CurrentStatus is a list ([1]) on WebSocket, a number on MQTT. */
function machineCodeOf(current) {
  if (Number.isInteger(current)) {
    return current;
  }
  if (Array.isArray(current)) {
    const codes = current.filter((code) => Number.isInteger(code));
    // Printing wins over the other activities reported at the same time.
    return codes.includes(1) ? 1 : (codes.find((code) => code !== 0) ?? codes[0]);
  }
  return undefined;
}

/** The phase of a job, from the machine status and the print sub-status. */
export function phaseOf(type, machineCode, printCode, errorNumber) {
  const table = type === 'fdm' ? FDM_PHASE : RESIN_PHASE;
  let phase = printCode === undefined ? undefined : (table[printCode] ?? 'unknown');
  const printing = machineCode === 1;
  if (!printing && machineCode !== undefined) {
    // Not printing: the sub-status keeps the end of the last job ("completed"),
    // anything still "active" there is stale.
    if (
      phase === undefined ||
      ACTIVE_PHASES.has(phase) ||
      phase === 'unknown' ||
      (phase === 'idle' && machineCode !== 0)
    ) {
      phase = machineCode === 0 ? 'idle' : 'busy';
    }
  } else if (printing && (phase === undefined || phase === 'idle' || phase === 'unknown')) {
    phase = type === 'fdm' && phase !== 'idle' ? 'printing' : 'preparing';
  } else if (printing && type === 'fdm' && FDM_MILESTONES.has(printCode)) {
    phase = 'printing';
  }
  if (errorNumber !== undefined && errorNumber > 0 && phase !== 'completed') {
    phase = 'error';
  }
  return phase ?? 'unknown';
}

const DAY_MS = 86_400_000;

/**
 * A status frame -> the normalized status, or undefined when it holds none.
 * `type` ('fdm' | 'resin') picks the sub-status table and the time unit.
 */
export function parseStatus(body, type) {
  const status = isObject(body?.Status)
    ? body.Status
    : isObject(body?.Data?.Status)
      ? body.Data.Status
      : undefined;
  if (!status) {
    return undefined;
  }
  const info = isObject(status.PrintInfo) ? status.PrintInfo : {};
  const machineCode = machineCodeOf(status.CurrentStatus);
  const printCode = Number.isInteger(info.Status) ? info.Status : undefined;
  if (machineCode === undefined && printCode === undefined) {
    return undefined;
  }
  // The FDM firmware counts in seconds, the resin one in milliseconds.
  const unit = type === 'fdm' ? 1000 : 1;
  const ms = (value) => {
    const n = num(value, 0, (30 * DAY_MS) / unit);
    return n === undefined ? undefined : n * unit;
  };
  const elapsedMs = ms(info.CurrentTicks);
  const totalMs = ms(info.TotalTicks);
  const layer = num(info.CurrentLayer, 0, 1_000_000);
  const totalLayers = num(info.TotalLayer, 0, 1_000_000);
  const errorNumber = num(info.ErrorNumber, 0, 1_000_000);
  const phase = phaseOf(type, machineCode, printCode, errorNumber);

  let progress = num(info.Progress, 0, 100);
  if (progress === undefined && layer !== undefined && totalLayers > 0) {
    progress = Math.min(100, (layer / totalLayers) * 100);
  }
  if (phase === 'completed') {
    progress = 100;
  } else if (phase === 'idle' || phase === 'busy') {
    progress = 0;
  }

  const temperature = (key, max = 400) =>
    key in status ? round1(num(status[key], -40, max)) : undefined;
  const fans = isObject(status.CurrentFanSpeed) ? status.CurrentFanSpeed : {};
  const fan = (key) => (key in fans ? num(fans[key], 0, 100) : undefined);

  return {
    machineCode,
    machine: MACHINE[machineCode] ?? (machineCode === undefined ? undefined : 'unknown'),
    printCode,
    phase,
    progress: progress === undefined ? undefined : Math.round(progress),
    layer,
    totalLayers,
    elapsedMs,
    remainingMs:
      elapsedMs !== undefined && totalMs !== undefined
        ? Math.max(0, totalMs - elapsedMs)
        : undefined,
    file: str(info.Filename, LIMITS.text),
    taskId: str(info.TaskId, 64),
    errorNumber,
    temperatures: {
      nozzle: temperature('TempOfNozzle'),
      bed: temperature('TempOfHotbed'),
      enclosure: temperature('TempOfBox', 150),
      uvled: temperature('TempOfUVLED', 150),
      vat: temperature('TempOfTank', 150),
    },
    fans: {
      model: fan('ModelFan'),
      auxiliary: fan('AuxiliaryFan'),
      enclosure: fan('BoxFan'),
    },
  };
}
