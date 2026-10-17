// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { LIMITS, REFRESH_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  refresh_interval: REFRESH_INTERVAL.default,
  allow_print_control: false,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * A printer address typed by the user: an IPv4 address or a host name. A
 * pasted URL ("ws://192.168.1.50:3030/websocket") is reduced to its host: the
 * SDCP ports are fixed (3030, 3000).
 * @returns {string | undefined} the host, undefined when invalid.
 */
export function parseHost(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d{1,5}$/, '')
    .toLowerCase();
  if (text === '' || text.length > 253) {
    return undefined;
  }
  if (/^[\d.]+$/.test(text)) {
    return IPV4.test(text) ? text : undefined;
  }
  return text.split('.').every((label) => LABEL.test(label)) ? text : undefined;
}

/** The addresses list: separated by commas, semicolons, spaces or new lines. */
export function parseAddresses(raw) {
  const valid = [];
  const invalid = [];
  for (const entry of String(raw ?? '').split(/[\s,;]+/)) {
    if (entry === '') {
      continue;
    }
    const host = parseHost(entry);
    if (!host) {
      invalid.push(entry.slice(0, 100));
    } else if (!valid.includes(host) && valid.length < LIMITS.addresses) {
      valid.push(host);
    }
  }
  return { valid, invalid };
}

const bool = (value) => value === true || value === 'true' || value === 1 || value === '1';

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null && v !== '')),
  };
  const { valid, invalid } = parseAddresses(raw?.addresses ?? '');
  const interval = Number(c.refresh_interval);
  return {
    addresses: valid,
    invalidAddresses: invalid,
    refreshInterval: Number.isFinite(interval)
      ? Math.min(REFRESH_INTERVAL.max, Math.max(REFRESH_INTERVAL.min, Math.round(interval)))
      : REFRESH_INTERVAL.default,
    allowPrintControl: bool(c.allow_print_control),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
