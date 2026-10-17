# TODO — Elegoo v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — SDCP V3 over WebSocket** (2026-10-17): typed addresses
      (unicast `M99999` identity, or the board id of the first frame), search
      through the core (`udp-active-broadcast`, port 3000), one WebSocket per
      printer with heartbeat, watchdog and bounded backoff, validated frames,
      resin and FDM statuses, devices and states, triggers (finished, error,
      paused), the `print_control` scene action off by default, `/data`
      registry, transport badges, manifest, docs en/fr, cover. Tested against
      simulated printers only.
- [ ] **Milestone 2 — real printers** (testers): record real frames as
      fixtures, fix what differs. To check first:
  - the reply to a unicast `M99999` from a container on a bridge network
    (does the printer answer the source port?), and the core's
    `udp-active-broadcast` on port 3000;
  - whether the printers answer `"pong"` to `"ping"` (the watchdog accepts
    any message, so a silent firmware is only a problem without status
    pushes) and whether a request with an empty `Id` is accepted (typed
    address without UDP answer);
  - the status pushes while idle (how often?), the `CurrentStatus` lists with
    several codes, the Saturn 4 Ultra 16K vat heater fields (`TempOfTank`);
  - Centauri Carbon: `CurrentTicks` really in seconds, `Progress`, the fan
    values in % (0-100, or 0-255?), the status table on the latest firmware;
  - the number of WebSocket clients each model accepts;
  - the acks of pause / resume / stop on each model.
- [ ] **Milestone 3 — more**: target temperatures, the print speed, the
      camera (RTSP `Cmd 386`, through a go2rtc-like sub-container), the
      Centauri Carbon 2 (CC2 MQTT protocol), the SDCP V1 MQTT printers, a
      "Forget a printer" action, a dashboard widget.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published
      (at milestone 1 its only error is the `docker_image` not yet pullable
      from GHCR).

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: elegoo-homeassistant (MIT) is Python, so its knowledge is ported, not
  imported (THIRD_PARTY_NOTICES.md): FDM status table, seconds instead of
  milliseconds, nozzle / bed / fan fields, families by model name. The SDCP
  V3.0.0 public document is the specification of the frames.
- Runtime dependency `ws` (MIT) besides the SDK: it is already in the SDK's
  dependency tree, and unlike Node's global `WebSocket` it bounds a message
  before buffering it (`maxPayload` 256 KB) and has a handshake timeout.
  No compression, no redirect.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow" (the template's 1.0.0 was someone
  else's). The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('printer', MainboardID)`, the board id of
  the frames, whatever the address or the name. Feature keys are frozen:
  `state`, `machine`, `progress`, `layer`, `total-layers`, `elapsed`,
  `remaining`, `file`, `error`, `error-code`, `nozzle-temperature`,
  `bed-temperature`, `enclosure-temperature`, `uvled-temperature`,
  `vat-temperature`, `model-fan`, `auxiliary-fan`, `enclosure-fan`.
- Typed addresses are the main path (a container hears no broadcast). Their
  identity comes from a unicast `M99999` (unicast crosses the bridge NAT);
  without an answer, the WebSocket is opened anyway and the board id of the
  first frame is adopted (requests then carry an empty `Id` until the
  attributes or the search give it: unverified on a real printer). The search
  uses the core's `udp-active-broadcast` on port 3000 (declared in
  `network_discovery`).
- A printer is shown in the Discovery tab once it sent one status: its family
  (resin or FDM) and its optional features come from it. Optional features
  only grow (a field missing once never removes one). A resin printer reports
  some temperatures as a constant 0 without a sensor: a resin temperature is
  a feature only once seen non-zero.
- Family: from the model (`centauri`/`neptune` FDM, `saturn`/`mars` resin);
  without a model yet, FDM if the status has `TempOfNozzle`.
- Units, after `DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core:
  `device-temperature-sensor` °C (machine temperatures, kept out of the room
  averages; the enclosure too), `duration` minutes (elapsed, remaining:
  minutes rather than seconds so the state changes once a minute), `fan` %.
  The progress is an `unknown` integer **without unit** (the core lists no
  unit for `unknown`; its name says "(%)"); layers and the error code too.
  Texts (`text`/`text`): print state, machine state, file (`-` when none, an
  empty text is refused), error.
- Phases: the machine status (`CurrentStatus`) says whether it prints; the
  print sub-status keeps the end of the last job (completed / stopped) while
  idle, and an "active" sub-status while not printing is stale (idle, or busy
  for a file transfer or a test). FDM: the "... completed" milestones (18 to 22) count as printing while the machine prints. `ErrorNumber` > 0 is an
  error unless completed.
- Triggers: only changes seen while connected (the first status after a
  connection is a baseline, never an event); finished once per `TaskId`,
  only from an active phase; error on entering the error phase, a new
  `ErrorNumber`, or an error frame; paused on entering "paused". The same
  error code fires once per job; another known job always fires; the
  10-minute window only applies when a job id is missing on either side.
  Fired only for created devices, at most 60 events a minute.
- Control: a scene action (not a feature), so no dashboard button can stop a
  print by a misclick; `allow_print_control` false by default, checked again
  when a queued command starts; one command at a time per printer; refused
  at once when the fresh read and the ack wait no longer fit the budget; a
  fresh status is asked first (2.5 s), the command is refused on no answer
  or a phase it does not fit (pause: printing; resume: paused; stop:
  preparing, printing, pausing, paused); the whole command (ack wait
  included) fits in 12 s after the scene reached the action. Declared
  timeout 30 s: the core starts counting when the scene enters the action,
  including up to 15 s of waiting for the integration's connection
  (runSceneAction.js, MESSAGE_CONNECTION_WAIT_MS), so 15 + 12 + 2 s margin
  fit (test/manifest.test.js). The ack is awaited 5 s; a missing ack, an
  answer without `Ack` or a connection lost after sending is reported "may
  have been applied". The connection itself only ever sends commands 0, 1,
  129, 130 and 131: no start (`Cmd 128`), no axis command, no file command.
- SDCP V1 printers (Saturn 3 Ultra, MQTT; elegoo-homeassistant README and
  its V1.0.0 fixture): recognised by `ProtocolVersion` V1 in the discovery
  answer, no WebSocket opened, named in the status as not supported. Kept in
  memory only (never a known printer, never stored, no place among the 20):
  a typed address is tried again at each configuration save or Gladys
  reconnection, the status only names the V1 addresses still typed or found
  by the last search, and a V1 answer is never believed for a socket that
  already speaks V3. Older discovery answers nest the fields under
  `Data.Attributes`: both read.
- A Gladys reconnection (`connected`, possibly a restarted core) publishes
  the Discovery tab and the status again, whatever was sent before.
- The Discovery tab is published at most once a second (bursts merged).
- One socket, one printer: the first frame of a new socket may move the
  address to another board (a printer replaced); afterwards, frames of
  other boards on that socket are ignored (a proxy without `?id=`, a hostile
  device). A search answer from one address for several boards keeps the
  first one. The unicast probe of a typed IP only accepts that IP's answer.
- The search is reused for 10 s (the core allows one scan per 10 s).
- `data.printers` has no prototype and is read with `Object.hasOwn`.
- Connection: heartbeat `"ping"` every 25 s as SDCP defines it, plus a
  WebSocket ping frame whose pong also counts; any message counts as alive;
  75 s (3 heartbeats) without anything closes it. Backoff 2 s, 5 s, 15 s,
  30 s, 1 min, 2 min, 5 min (repeated), reset after a connection that lived
  60 s. A status request (`Cmd 0`) every refresh interval (30 s by default,
  10 to 300 s).
- Frames: topic `sdcp/<status|attributes|response|error|notice>/<id>`, the
  board id in the frame must agree; numbers out of range are dropped, never
  clamped; texts stripped of control characters and bounded. Frames of
  another board at a known address: that printer took the address, the old
  one is unreachable until it shows up elsewhere.
- Two addresses for one printer (a name and an IP): the second connection is
  stopped (a printer accepts only a few clients), and started again if the
  first one is lost.
- A printer is forgotten when its device is deleted and its address is not
  typed. A typed printer stays connected; a printer found by the search is
  connected until it sent its state once (it is then in the Discovery tab),
  and again once its device is created. Moving or freeing an address
  re-synchronises the connections.
- When the state budget runs out, the states go before the measures;
  temperatures and fans spaced by 60 s per feature.
