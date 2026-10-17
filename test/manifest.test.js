// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  ACTIONS,
  CONTROL_COMMANDS,
  REFRESH_INTERVAL,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
  SDCP,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const allFields = [
  ...manifest.config_schema,
  ...[...manifest.actions, ...manifest.scene_triggers, ...manifest.scene_actions].flatMap(
    (item) => item.fields ?? [],
  ),
];

test('the store basics and the version 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene triggers and actions need Gladys 5.1');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-elegoo:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-elegoo');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Elegoo|sans\s+lien\s+avec\s+Elegoo/i);
    assert.match(docs, /never tested on a real printer|jamais testée sur une vraie imprimante/i);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of allFields.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('the only network capture: the SDCP discovery broadcast', () => {
  assert.deepEqual(manifest.network_discovery, [
    { type: 'udp-active-broadcast', ports: [SDCP.discoveryPort] },
  ]);
  assert.equal(manifest.containers, undefined);
});

test('the configuration matches the code; print control is off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.equal(fields.allow_print_control.type, 'boolean');
  assert.equal(fields.allow_print_control.default, false);
  assert.deepEqual(
    [fields.refresh_interval.min, fields.refresh_interval.max],
    [REFRESH_INTERVAL.min, REFRESH_INTERVAL.max],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('actions, scene triggers and the scene action are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  for (const trigger of manifest.scene_triggers) {
    const device = trigger.fields.find((f) => f.key === 'device');
    assert.equal(device.source, 'devices');
    assert.ok(trigger.variables.some((v) => v.key === 'file'));
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTIONS),
  );
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  const [control] = manifest.scene_actions;
  const command = control.fields.find((f) => f.key === 'command');
  assert.deepEqual(
    command.options.map((o) => o.value),
    CONTROL_COMMANDS,
  );
  assert.ok(!CONTROL_COMMANDS.includes('start'), 'never a print start');
  assert.ok(control.timeout_seconds >= 15);
  assert.equal(manifest.widgets, undefined);
});
