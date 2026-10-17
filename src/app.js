// -----------------------------------------------------------------------------
// The integration: the Elegoo printers it knows, one SDCP WebSocket to each,
// the Gladys devices built from them, their states, the scene triggers
// (print finished, error, paused), the print control scene action (off by
// default) and the "Find the printers" button. index.js only wires the SDK
// handlers to it.
//
// Addresses: the ones typed in the configuration (the main path: a container
// does not hear the LAN broadcasts), plus the printers found by the search
// (an SDCP "M99999" broadcast that the Gladys core sends for the container,
// `scanNetwork('udp-active-broadcast')`). A typed address is identified by a
// unicast "M99999" (src/sdcp/probe.js), or else by the board id of its first
// frame.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  CMD,
  CONTROL_CMD,
  CONTROL_COMMANDS,
  LIMITS,
  SCENE_TRIGGERS,
  SDCP,
  TIMINGS,
} from './constants.js';
import { jobEvents } from './events.js';
import { LocalizedError, T, frameErrorText, printErrorText, word } from './i18n.js';
import {
  EXTERNAL_ID_TYPE,
  buildDevice,
  capsOf,
  featureKeys,
  isMeasure,
  mergeCaps,
  statusValues,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { PrinterConnection } from './sdcp/connection.js';
import { probe as udpProbe } from './sdcp/probe.js';
import {
  parseAttributes,
  parseDiscovery,
  parseErrorFrame,
  isSdcpV1,
  parseStatus,
  printerTypeOf,
} from './sdcp/protocol.js';
import { FileStore, emptyData } from './store.js';

/** What each control command needs the print to be doing. */
const ALLOWED = {
  pause: new Set(['printing']),
  resume: new Set(['paused']),
  stop: new Set(['preparing', 'printing', 'pausing', 'paused']),
};

export class ElegooApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'elegoo' }),
    store = new FileStore(),
    createConnection = (options) => new PrinterConnection(options),
    probe = (host) => udpProbe(host),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.createConnection = createConnection;
    this.probe = probe;
    this.now = now;
    this.timers = timers;
    this.config = normalizeConfig();
    this.data = undefined;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    /** host -> { host, connection, lastProbe, probing } */
    this.hosts = new Map();
    /** printer id -> { status, at } the last status received */
    this.statuses = new Map();
    /** printer id -> the status events are computed from (none after a reconnection) */
    this.baselines = new Map();
    /** printer id -> { code } the last error frame, until a new job starts */
    this.frameErrors = new Map();
    /** printer id -> task id of the last "finished" event */
    this.finished = new Map();
    /** printer id -> [resolve] waiting for a fresh status */
    this.waiters = new Map();
    /** printer id -> the queue of its control commands */
    this.queues = new Map();
    /** featureId -> last value, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** deviceId -> transport badge last published */
    this.transports = new Map();
    this.eventWindow = [];
    /** printer id -> { code, taskId, at } of the last "print error" event */
    this.lastErrors = new Map();
    this.lastDevices = undefined;
    this.lastStatus = undefined;
    this.publishTimer = undefined;
    this.lastPublishAt = -Infinity;
    /** { at, found } the last search, reused for 10 s */
    this.lastDiscovery = undefined;
    this.refreshTimer = undefined;
    this.persistTimer = undefined;
    this.warned = new Set();
    this.discovering = undefined;
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    if (!this.data) {
      this.data = await this.store.load().catch(() => emptyData());
    }
    this.config = normalizeConfig(raw);
    this.started = true;
    this.refreshCreated();
    this.publisher.start();
    // An address once seen as SDCP V1 is tried again (a single answer, maybe
    // hostile, never blocks it for good).
    for (const [host, entry] of this.hosts) {
      if (entry.unsupported) {
        this.hosts.delete(host);
      }
    }
    this.syncConnections();
    this.schedule();
    // A (re)connection to Gladys may follow a restart of the core: the
    // Discovery tab and the status are published again, never assumed kept.
    this.lastDevices = undefined;
    this.lastStatus = undefined;
    await this.publishDevices();
    this.transports.clear();
    await this.publishAllTransports();
    this.updateStatus();
  }

  stop() {
    this.started = false;
    this.publisher.stop();
    this.timers.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.timers.clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    for (const entry of this.hosts.values()) {
      entry.connection.stop();
    }
    this.hosts.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  schedule() {
    this.timers.clearInterval(this.refreshTimer);
    this.refreshTimer = this.timers.setInterval(
      () => this.tick(),
      this.config.refreshInterval * 1000,
    );
  }

  /** One timer round: a status refresh of each printer, a probe of the unidentified addresses. */
  tick() {
    for (const entry of this.hosts.values()) {
      if (entry.duplicate || entry.unsupported) {
        continue;
      }
      if (entry.connection.connected && entry.connection.identity) {
        entry.connection.refresh();
      } else if (!entry.connection.identity) {
        this.identify(entry);
      }
    }
    this.updateStatus();
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, TIMINGS.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get records() {
    return Object.values(this.data?.printers ?? {});
  }

  /** The known printer of a board id (own keys only). */
  printerOf(id) {
    const printers = this.data?.printers;
    return printers && Object.hasOwn(printers, id) ? printers[id] : undefined;
  }

  // --- Connections -----------------------------------------------------------

  /** The addresses to connect to: the typed ones and those of the known printers. */
  wantedHosts() {
    const hosts = new Set(this.config.addresses);
    const created = this.createdDevices();
    for (const record of this.records) {
      if (!record.address) {
        continue;
      }
      // A printer whose device the user created, or one found by the search
      // until it sent its state once: then it waits in the Discovery tab
      // without holding one of the few connections the printer accepts.
      const isCreated = created.has(this.deviceIdOf(record.id));
      if (isCreated || (record.discovered && !record.seen)) {
        hosts.add(record.address);
      }
    }
    return [...hosts].slice(0, LIMITS.printers);
  }

  syncConnections() {
    const wanted = new Set(this.wantedHosts());
    for (const [host, entry] of this.hosts) {
      if (!wanted.has(host)) {
        entry.connection.stop();
        this.hosts.delete(host);
        // A removed main address lets a stopped second address take over.
        const id = entry.connection.identity?.mainboardId;
        if (id && !entry.duplicate) {
          this.restartDuplicates(id, host);
        }
      }
    }
    for (const host of wanted) {
      if (!this.hosts.has(host)) {
        this.openHost(host);
      }
    }
  }

  openHost(host) {
    const connection = this.createConnection({
      host,
      timers: this.timers,
      now: this.now,
      logger: this.logger,
    });
    const entry = { host, connection, lastProbe: -Infinity, probing: undefined, verified: false };
    this.hosts.set(host, entry);
    const record = this.records.find((r) => r.address === host);
    if (record) {
      connection.setIdentity({ mainboardId: record.id, connectionId: record.connectionId ?? '' });
    }
    connection.on('up', () => this.onUp(entry));
    connection.on('down', (info) => this.onDown(entry, info));
    connection.on('message', (message) => this.onMessage(entry, message));
    connection.start();
    if (!record) {
      this.identify(entry);
    }
  }

  /** A unicast "M99999" to an address whose printer is not known yet (at most once a minute). */
  identify(entry) {
    if (entry.probing || this.now() - entry.lastProbe < TIMINGS.probeRetry) {
      return entry.probing;
    }
    entry.lastProbe = this.now();
    entry.probing = this.probe(entry.host)
      .then((identity) => {
        if (identity && this.hosts.get(entry.host) === entry) {
          this.adopt(entry, identity);
        }
      })
      .catch((err) => this.logger.debug(`Probe of ${entry.host}: ${err.message}`))
      .finally(() => {
        entry.probing = undefined;
      });
    return entry.probing;
  }

  onUp(entry) {
    // A new socket: its first frame says which board answers at this address.
    entry.verified = false;
    const id = entry.connection.identity?.mainboardId;
    // A new connection: the next status is a baseline for the events.
    if (id) {
      this.baselines.delete(id);
      entry.connection.refresh({ attributes: true });
    } else {
      this.identify(entry);
    }
    this.connectionChanged(id);
  }

  onDown(entry, { wasUp }) {
    const id = entry.connection.identity?.mainboardId;
    if (id) {
      this.baselines.delete(id);
      this.restartDuplicates(id, entry.host);
    }
    if (wasUp) {
      this.connectionChanged(id);
    } else {
      this.updateStatus();
    }
  }

  /** A second address of printer `id`, stopped while `host` was up: it may take over. */
  restartDuplicates(id, host) {
    for (const other of this.hosts.values()) {
      if (other.duplicate && other.duplicateOf === id) {
        this.logger.info(`${host} lost: trying ${other.host} for printer ${id}`);
        other.duplicate = false;
        other.duplicateOf = undefined;
        other.verified = false;
        other.connection.start();
      }
    }
  }

  connectionChanged(id) {
    if (id) {
      this.publishTransport(this.deviceIdOf(id)).catch((err) =>
        this.logger.warn(`Transport badge failed: ${err.message}`),
      );
    }
    this.updateStatus();
  }

  /**
   * The printer at `entry` is `identity` (from a probe, a frame, the search).
   * Another printer known at this address has moved: its address is freed.
   */
  adopt(entry, identity) {
    if (isSdcpV1(identity)) {
      // SDCP V1 printers (Saturn 3 Ultra...) speak MQTT: no WebSocket to open.
      // Kept in memory only (never a known printer, never stored): the address
      // is tried again at the next configuration save or Gladys reconnection.
      if (entry.verified && entry.connection.connected) {
        // This socket already speaks SDCP V3: a V1 answer for it is not believed.
        this.warnOnce(`v1-ignored:${entry.host}`, `${entry.host}: SDCP V1 answer ignored`);
        return;
      }
      this.warnOnce(
        `v1:${entry.host}`,
        `${entry.host} is an SDCP V1 (MQTT) printer: not supported`,
      );
      entry.unsupported = true;
      entry.connection.stop();
      this.updateStatus();
      return;
    }
    if (this.isDuplicate(entry.host, identity.mainboardId)) {
      // Two addresses for one printer (a typed name and a found IP...): one
      // connection is enough, the printer accepts only a few. This one starts
      // again if the other one is lost.
      this.warnOnce(
        `duplicate:${entry.host}`,
        `${entry.host} is printer ${identity.mainboardId}, already connected at another address: ignored`,
      );
      entry.duplicate = true;
      entry.duplicateOf = identity.mainboardId;
      entry.connection.stop();
      this.updateStatus();
      return;
    }
    const changed = this.remember(identity, entry.host);
    const previous = entry.connection.identity?.mainboardId;
    entry.connection.setIdentity({
      mainboardId: identity.mainboardId,
      connectionId: this.printerOf(identity.mainboardId)?.connectionId ?? '',
    });
    if (previous !== identity.mainboardId && entry.connection.connected) {
      this.baselines.delete(identity.mainboardId);
      entry.connection.refresh({ attributes: true });
    }
    if (changed) {
      this.publishSoon();
      // A printer that left an address, or moved: the connections follow.
      queueMicrotask(() => {
        if (this.started) {
          this.syncConnections();
          this.updateStatus();
        }
      });
    }
  }

  /** True when printer `id` is known at another address whose connection is up. */
  isDuplicate(host, id) {
    const existing = this.printerOf(id);
    if (!existing?.address || existing.address === host) {
      return false;
    }
    const other = this.hosts.get(existing.address);
    return Boolean(other?.connection.connected && other.connection.identity?.mainboardId === id);
  }

  /** Adds or updates a known printer; true when its Gladys device changes. */
  remember(identity, host, { discovered = false } = {}) {
    const printers = this.data.printers;
    const existing = this.printerOf(identity.mainboardId);
    if (!existing && Object.keys(printers).length >= LIMITS.printers) {
      this.warnOnce('printers', `More than ${LIMITS.printers} printers: the next ones are ignored`);
      return false;
    }
    for (const other of this.records) {
      if (other.id !== identity.mainboardId && other.address === host) {
        this.logger.warn(
          `${host}: printer ${other.id} was known there, ${identity.mainboardId} answers now`,
        );
        other.address = '';
      }
    }
    const model = identity.model || existing?.model || '';
    const record = {
      caps: [],
      ...existing,
      id: identity.mainboardId,
      connectionId: identity.connectionId || existing?.connectionId || '',
      name: identity.name || existing?.name || '',
      model,
      firmware: identity.firmware || existing?.firmware || '',
      type: printerTypeOf(model) ?? existing?.type ?? '',
      address: host,
      discovered: Boolean(existing?.discovered || discovered),
    };
    if (JSON.stringify(existing) === JSON.stringify(record)) {
      return false;
    }
    if (existing && existing.address && existing.address !== host) {
      this.logger.info(`Printer ${record.id} is now at ${host}`);
    }
    printers[record.id] = record;
    this.persist();
    return true;
  }

  // --- Messages from the printers -----------------------------------------------

  onMessage(entry, message) {
    const board = message.mainboardId;
    const known = entry.connection.identity?.mainboardId;
    if (!entry.verified) {
      // The first frame of a new socket says which printer answers here: no
      // identity yet (no UDP answer), another printer took the address, or
      // this printer is already connected at another address.
      if (known !== board || this.printerOf(board)?.address !== entry.host) {
        if (known && known !== board) {
          this.logger.warn(`${entry.host}: frames of board ${board}, ${known} expected`);
        }
        this.adopt(entry, { mainboardId: board, connectionId: '' });
        if (entry.duplicate || entry.unsupported) {
          return;
        }
      }
      entry.verified = true;
    } else if (board !== known) {
      // Several boards on one socket (a proxy, a hostile device): the socket
      // keeps the printer of its first frame, the others are ignored.
      this.warnOnce(
        `foreign:${entry.host}:${board}`,
        `${entry.host}: frames of board ${board} ignored, this connection is printer ${known}`,
      );
      return;
    }
    const record = this.printerOf(board);
    if (!record || record.address !== entry.host) {
      return;
    }
    switch (message.kind) {
      case 'attributes':
        this.onAttributes(entry, record, message.body);
        break;
      case 'status':
        this.onStatus(record, message.body);
        break;
      case 'error':
        this.onErrorFrame(record, message.body);
        break;
      default:
        break;
    }
  }

  onAttributes(entry, record, body) {
    const identity = parseAttributes(body);
    if (!identity || identity.mainboardId !== record.id) {
      return;
    }
    if (this.remember({ ...identity, connectionId: '' }, entry.host)) {
      this.publishSoon();
    }
  }

  /** The SDCP family of a printer: from its model, else from what its status reports. */
  typeOf(record, body) {
    if (record.type) {
      return record.type;
    }
    const status = body?.Status ?? body?.Data?.Status;
    return status && typeof status === 'object' && 'TempOfNozzle' in status ? 'fdm' : 'resin';
  }

  onStatus(record, body) {
    const type = this.typeOf(record, body);
    const status = parseStatus(body, type);
    if (!status) {
      return;
    }
    this.statuses.set(record.id, { status, at: this.now() });
    const waiting = this.waiters.get(record.id) ?? [];
    this.waiters.delete(record.id);
    for (const finish of waiting) {
      finish(status);
    }

    let changed = false;
    if (!record.type) {
      record.type = type;
      changed = true;
    }
    const caps = mergeCaps(record.caps, capsOf(status, type));
    if (caps.length !== record.caps.length) {
      record.caps = caps;
      changed = true;
    }
    let firstSeen = false;
    if (!record.seen) {
      record.seen = true;
      changed = true;
      firstSeen = true;
    }
    if (changed) {
      this.persist();
      this.publishSoon();
    }
    if (firstSeen && record.discovered) {
      // Found by the search and now in the Discovery tab: its connection is
      // released until the user creates its device (src/app.js wantedHosts).
      queueMicrotask(() => {
        if (this.started) {
          this.syncConnections();
          this.updateStatus();
        }
      });
    }

    const previous = this.baselines.get(record.id);
    if (previous && status.taskId && previous.taskId && status.taskId !== previous.taskId) {
      // A new job: the error frame of the previous one is over.
      this.frameErrors.delete(record.id);
    }
    if (status.phase === 'preparing' && previous && previous.phase !== 'preparing') {
      this.frameErrors.delete(record.id);
    }
    this.baselines.set(record.id, status);
    this.recordValues(
      record,
      statusValues(record, status, this.config.language, this.frameErrors.get(record.id)),
    );
    for (const key of jobEvents(previous, status)) {
      this.jobEvent(record, key, status);
    }
  }

  onErrorFrame(record, body) {
    const { code } = parseErrorFrame(body);
    this.frameErrors.set(record.id, { code });
    this.logger.warn(`Printer ${record.id} reports error ${code}`);
    const current = this.statuses.get(record.id)?.status;
    if (current) {
      this.recordValues(record, statusValues(record, current, this.config.language, { code }));
    }
    if (this.repeatedError(record, `frame:${code}`, current?.taskId)) {
      return;
    }
    this.fireEvent(record, SCENE_TRIGGERS.ERROR, {
      file: current?.file ?? '',
      error_code: code,
      error: word(frameErrorText(code), this.config.language),
    });
  }

  jobEvent(record, key, status) {
    if (key === SCENE_TRIGGERS.FINISHED) {
      // Once per job, even if the printer goes back and forth.
      if (status.taskId && this.finished.get(record.id) === status.taskId) {
        return;
      }
      this.finished.set(record.id, status.taskId);
    }
    const data = { file: status.file ?? '' };
    if (key === SCENE_TRIGGERS.ERROR) {
      data.error_code = status.errorNumber > 0 ? status.errorNumber : -1;
      data.error = word(printErrorText(status.errorNumber ?? 0, 'error'), this.config.language);
      if (this.repeatedError(record, `print:${data.error_code}`, status.taskId)) {
        return;
      }
    }
    this.fireEvent(record, key, data);
  }

  /**
   * True when the same error code was already reported for the same job: a
   * printer flapping in and out of an error fires "print error" once. Another
   * known job always fires; the 10-minute window only applies when a job id
   * is missing on either side.
   */
  repeatedError(record, code, taskId) {
    const last = this.lastErrors.get(record.id);
    const time = this.now();
    if (last?.code === code) {
      const repeated =
        taskId && last.taskId ? taskId === last.taskId : time - last.at < TIMINGS.errorRepeat;
      if (repeated) {
        return true;
      }
    }
    this.lastErrors.set(record.id, { code, taskId, at: time });
    return false;
  }

  fireEvent(record, key, data) {
    const device = this.deviceIdOf(record.id);
    if (!this.createdDevices().has(device)) {
      return;
    }
    const time = this.now();
    this.eventWindow = this.eventWindow.filter((t) => time - t < 60_000);
    if (this.eventWindow.length >= LIMITS.eventsPerMinute) {
      this.warnOnce('events', 'Too many scene events in a minute: the next ones are dropped');
      return;
    }
    this.eventWindow.push(time);
    this.logger.info(`Printer ${record.id}: ${key}`);
    this.gladys
      .publishSceneEvent(key, { device, ...data })
      .catch((err) => this.logger.warn(`Scene event failed: ${err.message}`));
  }

  recordValues(record, values) {
    const ids = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id);
    for (const [key, value] of values) {
      const featureId = ids.feature(key);
      this.lastValues.set(featureId, value);
      if (this.created.has(featureId)) {
        this.publisher.push(featureId, value);
      }
    }
  }

  // --- Gladys devices ----------------------------------------------------------

  deviceIdOf(id) {
    return this.gladys.externalIds(EXTERNAL_ID_TYPE, id).device;
  }

  /** The printers shown in the Discovery tab: those that sent a status once. */
  visibleRecords() {
    return this.records.filter((record) => record.seen);
  }

  /**
   * Publishes the Discovery tab soon: the changes of a burst of frames are
   * merged, and it is published at most once per TIMINGS.publishDelay.
   */
  publishSoon() {
    if (this.publishTimer) {
      return;
    }
    const wait = Math.max(0, this.lastPublishAt + TIMINGS.publishDelay - this.now());
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = undefined;
      this.publishDevices().catch(() => {});
    }, wait);
  }

  async publishDevices() {
    this.lastPublishAt = this.now();
    const records = this.visibleRecords();
    const devices = records.map((record) => buildDevice(this.gladys, record, this.config.language));
    const measures = new Set();
    for (const record of records) {
      const ids = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id);
      for (const key of featureKeys(record)) {
        if (isMeasure(key)) {
          measures.add(ids.feature(key));
        }
      }
    }
    this.publisher.configure({ throttled: measures });
    const key = JSON.stringify(devices);
    if (key === this.lastDevices) {
      return;
    }
    this.lastDevices = key;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the discovered devices failed: ${err.message}`));
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  async deviceCreated(device) {
    this.refreshCreated();
    // A printer found by the search is connected again once its device exists.
    this.syncConnections();
    this.transports.delete(device?.external_id);
    const record = device?.external_id ? this.recordOf(device.external_id) : undefined;
    const last = record ? this.statuses.get(record.id) : undefined;
    // Only recent values are sent at creation; otherwise the printer is asked
    // again (a printer found by the search was released since its last state).
    if (last && this.now() - last.at <= 2 * this.config.refreshInterval * 1000) {
      for (const feature of device?.features ?? []) {
        const value = this.lastValues.get(feature.external_id);
        if (value) {
          this.publisher.push(feature.external_id, value);
        }
      }
    } else if (record) {
      const connection = this.connectionOf(record);
      if (connection?.connected) connection.refresh();
    }
    if (device?.external_id) {
      await this.publishTransport(device.external_id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (!device?.external_id) {
      return;
    }
    this.transports.delete(device.external_id);
    this.publisher.forget(device.external_id);
    const record = this.recordOf(device.external_id);
    // A printer that is not typed in the configuration is forgotten with its device.
    if (record && !this.config.addresses.includes(record.address)) {
      delete this.data.printers[record.id];
      this.persist();
      this.syncConnections();
      await this.publishDevices();
      this.updateStatus();
    }
  }

  recordOf(deviceId) {
    return this.records.find((record) => this.deviceIdOf(record.id) === deviceId);
  }

  connectionOf(record) {
    const entry = record.address ? this.hosts.get(record.address) : undefined;
    return entry?.connection.identity?.mainboardId === record.id ? entry.connection : undefined;
  }

  transportOf(record) {
    return this.connectionOf(record)?.connected
      ? DEVICE_TRANSPORTS.LOCAL
      : DEVICE_TRANSPORTS.UNREACHABLE;
  }

  async publishTransport(deviceId) {
    const record = this.recordOf(deviceId);
    if (!record || !this.createdDevices().has(deviceId)) {
      return;
    }
    const transport = this.transportOf(record);
    if (this.transports.get(deviceId) === transport) {
      return;
    }
    this.transports.set(deviceId, transport);
    await this.gladys.publishTransports([{ external_id: deviceId, transport }]);
  }

  async publishAllTransports() {
    const created = this.createdDevices();
    const entries = [];
    for (const record of this.records) {
      const deviceId = this.deviceIdOf(record.id);
      if (!created.has(deviceId)) {
        continue;
      }
      const transport = this.transportOf(record);
      if (this.transports.get(deviceId) !== transport) {
        this.transports.set(deviceId, transport);
        entries.push({ external_id: deviceId, transport });
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  updateStatus() {
    if (!this.started) {
      return;
    }
    const hosts = [...this.hosts.values()].filter((e) => !e.duplicate && !e.unsupported);
    const up = hosts.filter((entry) => entry.connection.connected);
    // Only the SDCP V1 addresses still typed (their entries) or found by the last search.
    const unsupported = new Set([
      ...[...this.hosts.values()].filter((e) => e.unsupported).map((e) => e.host),
      ...(this.lastDiscovery?.found ?? [])
        .filter((p) => isSdcpV1(p) && !hosts.some((e) => e.host === p.host))
        .map((p) => p.host),
    ]);
    const parts = [];
    let connected;
    if (hosts.length === 0 && unsupported.size > 0) {
      connected = false;
    } else if (hosts.length === 0) {
      connected = false;
      parts.push(T.noPrinter);
    } else {
      connected = up.length > 0;
      parts.push(T.status(up.length, hosts.length));
      const down = hosts.filter((entry) => !entry.connection.connected).map((e) => e.host);
      if (down.length > 0) {
        parts.push(T.waiting(down));
      }
    }
    if (unsupported.size > 0) {
      parts.push(T.sdcpV1([...unsupported]));
    }
    if (this.config.invalidAddresses.length > 0) {
      parts.push(T.invalidAddresses(this.config.invalidAddresses));
    }
    const message = {
      en: parts.map((p) => p.en).join(' '),
      fr: parts.map((p) => p.fr).join(' '),
    };
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Search ------------------------------------------------------------------

  /** The SDCP broadcast sent by the Gladys core; the answers become known printers. */
  discover() {
    // The core allows one scan per 10 s: a recent result is shown again
    // rather than its "too many requests".
    if (this.lastDiscovery && this.now() - this.lastDiscovery.at < TIMINGS.discoveryReuse) {
      return Promise.resolve(this.lastDiscovery.found);
    }
    if (!this.discovering) {
      this.discovering = this.doDiscover()
        .then((found) => {
          this.lastDiscovery = { at: this.now(), found };
          return found;
        })
        .finally(() => {
          this.discovering = undefined;
        });
    }
    return this.discovering;
  }

  async doDiscover() {
    const replies = await this.gladys.scanNetwork('udp-active-broadcast', {
      port: SDCP.discoveryPort,
      payload: Buffer.from(SDCP.discoveryMessage),
      timeoutSeconds: TIMINGS.scanSeconds,
    });
    const found = new Map();
    const sources = new Map();
    for (const reply of Array.isArray(replies) ? replies : []) {
      if (typeof reply?.payload_base64 !== 'string' || typeof reply.source_ip !== 'string') {
        continue;
      }
      const identity = parseDiscovery(Buffer.from(reply.payload_base64, 'base64'));
      // The address that answered, rather than the one the printer says it has.
      const host = reply.source_ip.replace(/^::ffff:/, '');
      if (!identity || found.has(identity.mainboardId)) {
        continue;
      }
      // One address, one printer: a proxy or a hostile device answering for
      // several boards only gets its first one.
      if (sources.has(host)) {
        this.warnOnce(
          `sources:${host}:${identity.mainboardId}`,
          `${host} answered the search as several printers: only ${sources.get(host)} is kept`,
        );
        continue;
      }
      sources.set(host, identity.mainboardId);
      found.set(identity.mainboardId, { ...identity, host });
    }
    for (const identity of found.values()) {
      if (isSdcpV1(identity)) {
        // Never a known printer; an open WebSocket at that address is stopped
        // (unless it already speaks SDCP V3, see adopt).
        const entry = this.hosts.get(identity.host);
        if (entry) {
          this.adopt(entry, identity);
        }
        continue;
      }
      if (this.isDuplicate(identity.host, identity.mainboardId)) {
        // Already connected under another address: only its details are updated.
        this.remember(identity, this.printerOf(identity.mainboardId).address);
        continue;
      }
      this.remember(identity, identity.host, { discovered: true });
      const entry = this.hosts.get(identity.host);
      if (entry && !entry.duplicate) {
        this.adopt(entry, identity);
      }
    }
    this.syncConnections();
    return [...found.values()];
  }

  async scan() {
    await this.discover().catch((err) => this.logger.warn(`Search failed: ${err.message}`));
    await this.publishDevices();
    this.updateStatus();
  }

  async findPrinters() {
    let found;
    try {
      found = await this.discover();
    } catch (err) {
      return T.find.failed(err.message);
    }
    this.updateStatus();
    if (found.length === 0) {
      return T.find.none;
    }
    return T.find.found(
      found.map(
        (p) =>
          `${p.name || p.model || 'Elegoo'} ${p.model ? `(${p.model}) ` : ''}${p.host}` +
          (isSdcpV1(p) ? ' [SDCP V1]' : ''),
      ),
    );
  }

  // --- Print control (scene action) ------------------------------------------------

  /**
   * Pause, resume or stop the current print of a printer. Off unless
   * `allow_print_control` is set. Never sent on a state that is unknown or
   * stale: a fresh status is asked first, and the command is refused when the
   * print is not in a state it applies to. One command at a time per printer.
   */
  control({ device, command } = {}) {
    const start = this.now();
    const fail = (text) => Promise.reject(new LocalizedError(text, this.config.language));
    if (!this.config.allowPrintControl) {
      return fail(T.control.disabled);
    }
    if (!CONTROL_COMMANDS.includes(command)) {
      return fail(T.control.unknownCommand);
    }
    const record = typeof device === 'string' ? this.recordOf(device) : undefined;
    if (!record) {
      return fail(T.control.noPrinter);
    }
    const queue = this.queues.get(record.id) ?? Promise.resolve();
    const run = queue.catch(() => {}).then(() => this.doControl(record, command, start));
    this.queues.set(record.id, run);
    run
      .finally(() => {
        if (this.queues.get(record.id) === run) this.queues.delete(record.id);
      })
      .catch(() => {});
    return run;
  }

  async doControl(record, command, start) {
    const name = record.name || record.model || record.id;
    const fail = (text) => {
      throw new LocalizedError(text, this.config.language);
    };
    // Checked again here: the option may have been turned off while this
    // command waited behind another one.
    if (!this.config.allowPrintControl) {
      fail(T.control.disabled);
    }
    const connection = this.connectionOf(record);
    if (!connection?.connected) {
      fail(T.control.offline(name));
    }
    // Not even the time to read the state and wait for the ack: refused now.
    if (this.now() - start + TIMINGS.freshStatus + TIMINGS.commandAck > TIMINGS.controlBudget) {
      fail(T.control.late(name));
    }
    const status = await this.freshStatus(record, connection);
    if (!status) {
      fail(T.control.stale(name));
    }
    if (!ALLOWED[command].has(status.phase)) {
      fail(T.control.notNow(name, command, status.phase));
    }
    if (this.now() - start + TIMINGS.commandAck > TIMINGS.controlBudget) {
      fail(T.control.late(name));
    }
    // Last check right before sending: the option may have been turned off meanwhile.
    if (!this.config.allowPrintControl) {
      fail(T.control.disabled);
    }
    this.logger.info(`Printer ${record.id}: ${command} asked by a scene`);
    let answer;
    try {
      answer = await connection.request(CONTROL_CMD[command], {}, { timeout: TIMINGS.commandAck });
    } catch (err) {
      // Sent but unanswered (timeout, connection lost meanwhile): it may have been applied.
      fail(
        err.kind === 'timeout' || err.kind === 'lost'
          ? T.control.noAnswer(name)
          : T.control.offline(name),
      );
    }
    if (answer.ack === undefined) {
      fail(T.control.noAnswer(name));
    }
    if (answer.ack !== 0) {
      fail(T.control.refused(name, answer.ack));
    }
    connection.refresh();
    return undefined;
  }

  /** Asks the printer for its status and resolves with the one received after, or undefined. */
  freshStatus(record, connection) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (status) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        const list = this.waiters.get(record.id);
        if (list) {
          const index = list.indexOf(finish);
          if (index >= 0) list.splice(index, 1);
        }
        resolve(status);
      };
      const timer = this.timers.setTimeout(() => finish(undefined), TIMINGS.freshStatus);
      if (!this.waiters.has(record.id)) {
        this.waiters.set(record.id, []);
      }
      this.waiters.get(record.id).push(finish);
      connection.request(CMD.STATUS, {}, { timeout: TIMINGS.freshStatus }).catch(() => {});
    });
  }
}
