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
    this.lastDevices = undefined;
    this.lastStatus = undefined;
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
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.started = true;
    this.refreshCreated();
    this.publisher.start();
    this.syncConnections();
    this.schedule();
    if (previous.language !== this.config.language) {
      this.lastDevices = undefined;
    }
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

  // --- Connections -----------------------------------------------------------

  /** The addresses to connect to: the typed ones and those of the known printers. */
  wantedHosts() {
    const hosts = new Set(this.config.addresses);
    const created = this.createdDevices();
    for (const record of this.records) {
      // A printer found by the search, or whose device the user created.
      if (record.address && (record.discovered || created.has(this.deviceIdOf(record.id)))) {
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
    const entry = { host, connection, lastProbe: -Infinity, probing: undefined };
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
    }
    if (wasUp) {
      this.connectionChanged(id);
    } else {
      this.updateStatus();
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
    if (this.isDuplicate(entry.host, identity.mainboardId)) {
      // Two addresses for one printer (a typed name and a found IP...): one
      // connection is enough, the printer accepts only a few.
      this.warnOnce(
        `duplicate:${entry.host}`,
        `${entry.host} is printer ${identity.mainboardId}, already connected at another address: ignored`,
      );
      entry.duplicate = true;
      entry.connection.stop();
      this.updateStatus();
      return;
    }
    const changed = this.remember(identity, entry.host);
    const previous = entry.connection.identity?.mainboardId;
    entry.connection.setIdentity({
      mainboardId: identity.mainboardId,
      connectionId: this.data.printers[identity.mainboardId]?.connectionId ?? '',
    });
    if (previous !== identity.mainboardId && entry.connection.connected) {
      this.baselines.delete(identity.mainboardId);
      entry.connection.refresh({ attributes: true });
    }
    if (changed) {
      this.publishDevices().catch(() => {});
    }
  }

  /** True when printer `id` is known at another address whose connection is up. */
  isDuplicate(host, id) {
    const existing = this.data.printers[id];
    if (!existing?.address || existing.address === host) {
      return false;
    }
    const other = this.hosts.get(existing.address);
    return Boolean(other?.connection.connected && other.connection.identity?.mainboardId === id);
  }

  /** Adds or updates a known printer; true when its Gladys device changes. */
  remember(identity, host, { discovered = false } = {}) {
    const printers = this.data.printers;
    const existing = printers[identity.mainboardId];
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
    const known = entry.connection.identity?.mainboardId;
    if (known !== message.mainboardId) {
      // No identity yet (no UDP answer), or another printer at this address.
      if (known) {
        this.logger.warn(
          `${entry.host}: frames of board ${message.mainboardId}, ${known} expected`,
        );
      }
      this.adopt(entry, { mainboardId: message.mainboardId, connectionId: '' });
    }
    const record = this.data.printers[message.mainboardId];
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
      this.publishDevices().catch(() => {});
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
    if (!record.seen) {
      record.seen = true;
      changed = true;
    }
    if (changed) {
      this.persist();
      this.publishDevices().catch(() => {});
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
    }
    this.fireEvent(record, key, data);
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

  async publishDevices() {
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
    this.transports.delete(device?.external_id);
    for (const feature of device?.features ?? []) {
      const value = this.lastValues.get(feature.external_id);
      if (value) {
        this.publisher.push(feature.external_id, value);
      }
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
    const hosts = [...this.hosts.values()].filter((entry) => !entry.duplicate);
    const up = hosts.filter((entry) => entry.connection.connected);
    const parts = [];
    let connected;
    if (hosts.length === 0) {
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
    if (!this.discovering) {
      this.discovering = this.doDiscover().finally(() => {
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
    for (const reply of Array.isArray(replies) ? replies : []) {
      if (typeof reply?.payload_base64 !== 'string' || typeof reply.source_ip !== 'string') {
        continue;
      }
      const identity = parseDiscovery(Buffer.from(reply.payload_base64, 'base64'));
      // The address that answered, rather than the one the printer says it has.
      const host = reply.source_ip.replace(/^::ffff:/, '');
      if (identity && !found.has(identity.mainboardId)) {
        found.set(identity.mainboardId, { ...identity, host });
      }
    }
    for (const identity of found.values()) {
      if (this.isDuplicate(identity.host, identity.mainboardId)) {
        // Already connected under another address: only its details are updated.
        this.remember(identity, this.data.printers[identity.mainboardId].address);
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
        (p) => `${p.name || p.model || 'Elegoo'} ${p.model ? `(${p.model}) ` : ''}${p.host}`,
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
    const connection = this.connectionOf(record);
    if (!connection?.connected) {
      fail(T.control.offline(name));
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
    this.logger.info(`Printer ${record.id}: ${command} asked by a scene`);
    let answer;
    try {
      answer = await connection.request(CONTROL_CMD[command], {}, { timeout: TIMINGS.commandAck });
    } catch (err) {
      fail(err.kind === 'timeout' ? T.control.noAnswer(name) : T.control.offline(name));
    }
    if (answer.ack !== undefined && answer.ack !== 0) {
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
