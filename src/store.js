// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume): the known printers (board id, brand id, address, model, type,
// capabilities), so a printer switched off keeps its device and features.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// No prototype: a board id can never reach Object.prototype ("__proto__"...).
export const emptyData = () => ({ printers: Object.create(null) });

function sanitize(data) {
  const base = emptyData();
  if (data && typeof data === 'object' && data.printers && typeof data.printers === 'object') {
    for (const id of Object.keys(data.printers)) {
      const record = data.printers[id];
      if (/^[0-9A-Za-z]{1,64}$/.test(id) && record && typeof record === 'object') {
        // eslint-disable-next-line no-unused-vars
        const { unsupported, ...kept } = record; // SDCP V1 is never stored (src/app.js adopt)
        base.printers[id] = { ...kept, id, caps: Array.isArray(record.caps) ? record.caps : [] };
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'elegoo.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
  }

  async load() {
    try {
      return sanitize(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = structuredClone(data);
    this.saves = 0;
  }

  async load() {
    return sanitize(structuredClone(this.data));
  }

  async save(data) {
    this.data = structuredClone(data);
    this.saves += 1;
  }
}
