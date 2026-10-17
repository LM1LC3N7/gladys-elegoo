# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Elegoo 3D printers that speak
SDCP V3 on the local network (resin Saturn / Mars, FDM Centauri Carbon): a
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its other runtime dependency is [`ws`](https://github.com/websockets/ws), the
WebSocket client (already a dependency of the SDK). It started from the
official JavaScript template. See `TODO.md` for the status and the decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "control" # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> ElegooApp (shared with the tests)
src/app.js                        ElegooApp: known printers, connections, states, events, control
src/sdcp/connection.js            one WebSocket per printer: heartbeat, watchdog, backoff, requests
src/sdcp/protocol.js              SDCP frames validated and normalized, requests built (pure)
src/sdcp/probe.js                 unicast "M99999" (UDP 3000) to identify a typed address
src/model.js                      known printers -> Gladys devices and states (pure)
src/events.js                     scene trigger events from two statuses (pure)
src/publisher.js                  states within the rate limit (250/min), measures spaced
src/store.js                      /data/elegoo.json (known printers)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, SDCP numbers, limits, timings; texts en/fr
scripts/cover.mjs                 cover.png generator (plain Node)
gladys-assistant-integration.json manifest: name, config_schema, actions, triggers, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys, fake printers and sockets
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('printer', MainboardID)`,
  the board id of the SDCP frames, never an address or a name. Feature keys
  (`src/model.js` SPECS), manifest keys and scene keys are frozen too.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Safety.** No command starts a print or moves an axis, ever. Pause, resume
  and stop exist only as a scene action, refused unless `allow_print_control`
  is set, sent only after a fresh status shows a state they apply to, one at a
  time per printer, and never later than `TIMINGS.controlBudget`.
- **Nothing from the network is trusted.** Messages are bounded (`ws`
  `maxPayload`), parsed in `src/sdcp/protocol.js`, their topic and board id
  checked, every number range-checked (dropped, never clamped).
- **Units.** Only the ones the Gladys core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY` of `server/utils/constants.js`);
  `test/model.test.js` checks them. Units and types are fixed at creation.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, see TODO.md). `test/manifest.test.js`
  checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading: the Release workflow moves
  the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **User-facing text** is bilingual (English and French), kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
- **Encoding.** Every file is UTF-8 without BOM; `test/encoding.test.js`
  refuses mojibake in the manifest, the docs and these files.
