// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the SDCP V3 protocol numbers, limits and timings.
//
// SDCP: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
// (Elegoo's public protocol); the FDM status table and the field names the
// Centauri Carbon adds come from danielcherubini/elegoo-homeassistant (MIT).
// -----------------------------------------------------------------------------

/** Manifest `actions` keys. */
export const ACTIONS = {
  FIND: 'find_printers',
};

/** Manifest `scene_triggers` keys. */
export const SCENE_TRIGGERS = {
  FINISHED: 'print_finished',
  ERROR: 'print_error',
  PAUSED: 'print_paused',
};

/** Manifest `scene_actions` keys. */
export const SCENE_ACTIONS = {
  CONTROL: 'print_control',
};

/** The commands of the `print_control` scene action. Never "start", never an axis move. */
export const CONTROL_COMMANDS = ['pause', 'resume', 'stop'];

export const SDCP = {
  /** The WebSocket of the mainboard: ws://<ip>:3030/websocket. */
  wsPort: 3030,
  wsPath: '/websocket',
  /** UDP discovery: "M99999" to port 3000, the printer answers in unicast. */
  discoveryPort: 3000,
  discoveryMessage: 'M99999',
  /** Heartbeat, as the protocol defines it: the text "ping", answered "pong". */
  ping: 'ping',
  pong: 'pong',
  /** "From" of the requests: 0 = local PC software on the LAN. */
  from: 0,
};

/** The SDCP commands this integration sends. Start (128) and moves are never sent. */
export const CMD = {
  STATUS: 0,
  ATTRIBUTES: 1,
  PAUSE: 129,
  STOP: 130,
  RESUME: 131,
};

/** The control command of each scene action command. */
export const CONTROL_CMD = {
  pause: CMD.PAUSE,
  resume: CMD.RESUME,
  stop: CMD.STOP,
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Gladys accepts 300 scene events per minute per integration. */
  eventsPerMinute: 60,
  /** Printers handled. */
  printers: 20,
  /** Addresses typed in the configuration. */
  addresses: 20,
  /** One WebSocket message (status and attributes frames are a few kB). */
  messageBytes: 256 * 1024,
  /** One UDP discovery answer. */
  datagramBytes: 4096,
  /** Texts kept from the printer (names, file names). */
  text: 200,
};

export const TIMINGS = {
  /** WebSocket opening handshake. */
  connectTimeout: 10_000,
  /** The protocol heartbeat ("ping") is sent this often. */
  heartbeat: 25_000,
  /** Nothing received (not even "pong") for this long: the connection is dead. */
  watchdog: 75_000,
  /** Reconnection delays, growing, the last one repeated. */
  backoff: [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  /** A connection that lived this long resets the backoff. */
  stableAfter: 60_000,
  /** Unicast "M99999" probe of a typed address. */
  probeTimeout: 2_000,
  /** A typed address whose identity is unknown is probed again this often. */
  probeRetry: 60_000,
  /** Discovery broadcast by the core (seconds, 1-30). */
  scanSeconds: 3,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** Temperatures and fan speeds of a feature are spaced by this much. */
  measureInterval: 60_000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** Saving /data waits this long for more changes. */
  persistDelay: 1000,
  /** Before a control command: a fresh status is awaited at most this long. */
  freshStatus: 2_500,
  /** The acknowledgement of a control command is awaited at most this long. */
  commandAck: 5_000,
  /**
   * A control command is never sent later than this after the scene reached
   * it, so that its answer still fits the declared `timeout_seconds` (15 s):
   * a command is refused before acting, never sent after the failure shown.
   */
  controlBudget: 12_000,
};

/** Configuration bounds (mirrored by the manifest). */
export const REFRESH_INTERVAL = { default: 30, min: 10, max: 300 };
