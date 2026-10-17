# gladys-elegoo

[Gladys Assistant](https://gladysassistant.com) external integration for
**Elegoo 3D printers** that speak SDCP V3 on the local network: resin (Saturn
3 / 4 Ultra, Mars 5 Ultra) and FDM (Centauri Carbon). Print state, progress,
layers, times, file, temperatures and fans become Gladys devices; scene
triggers fire when a print finishes, fails or is paused; a scene action can
pause, resume or stop a print, off by default. No Elegoo cloud. Unofficial,
not affiliated with Elegoo.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, never tested on a real printer:
> checked against simulated SDCP printers only.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (ElegooApp)
                                   ├─ src/sdcp/connection.js  ws://<ip>:3030/websocket per printer (ws)
                                   ├─ src/sdcp/protocol.js    frames validated and normalized (pure)
                                   ├─ src/sdcp/probe.js       unicast "M99999" to UDP 3000 (identity)
                                   ├─ src/model.js            printers -> Gladys devices and states (pure)
                                   ├─ src/events.js           finished / error / paused (pure)
                                   ├─ src/publisher.js        states within 250/min (Gladys: 300), measures spaced
                                   └─ src/store.js            /data/elegoo.json: known printers
```

- **Printers** are added by IP address (the main path: the container is on a
  bridge network and hears no broadcast), identified by a unicast `M99999` on
  UDP 3000, or else by the board id of their first frame. "Find the printers"
  asks the Gladys core to broadcast `M99999`
  (`scanNetwork('udp-active-broadcast')`, port 3000) and reads the answers.
  External ids: `printer:<MainboardID>`.
- **One WebSocket per printer**, `ws` with `maxPayload` 256 KB, no
  compression, no redirect. The SDCP heartbeat (`"ping"` text, `"pong"`
  answer) every 25 s; nothing received for 75 s closes the connection;
  reconnection after 2 s, 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min
  (back to 2 s after a connection that lasted a minute). Every frame is
  checked (topic, board id, ranges) before use.
- **States** come from the status frames the printer pushes, plus a status
  request (`Cmd 0`) every refresh interval. FDM firmware counts times in
  seconds and has its own print status table (after elegoo-homeassistant).
- **Control**: the `print_control` scene action (pause `Cmd 129`, stop
  `Cmd 130`, resume `Cmd 131`) is refused unless `allow_print_control` is set,
  asks a fresh status first and refuses on an unknown or unfitting state, runs
  one command at a time per printer and waits 5 s for the acknowledgement.
  Start (`Cmd 128`) and axis moves are never sent.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/helpers/fakes.js` holds a clock the tests advance, a fake SDCP printer
(resin and FDM frames shaped like the protocol and the Home Assistant
fixtures) and a fake WebSocket; the end-to-end tests run the real handlers
against the SDK's fake Gladys.

## Credits

- [`elegoo-homeassistant`](https://github.com/danielcherubini/elegoo-homeassistant)
  by Daniel Cherubini (MIT): the FDM status table, field names and time units,
  the printer families, ported to JavaScript (no code copied).
- Elegoo's public
  [SDCP V3.0.0 protocol](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0).
- [`ws`](https://github.com/websockets/ws) (MIT), the WebSocket client.
- `src/publisher.js` comes from
  [LM1LC3N7/gladys-mystrom](https://github.com/LM1LC3N7/gladys-mystrom) (same
  author, Apache-2.0).

Elegoo, Saturn, Mars and Centauri are trademarks of their owners, used here
only to name the compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices
(elegoo-homeassistant, MIT): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
