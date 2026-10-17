# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Elegoo SDCP V3 printers on the local network, without the cloud: resin
  (Saturn 4 Ultra and 16K, Mars 5 Ultra) and FDM (Centauri Carbon), added by IP
  address or found by the "Find the printers" search (through Gladys), and
  recognised by their board id when their address changes.
- Print state, machine state, progress, current and total layers, time
  elapsed and remaining, file name, error; nozzle, bed and enclosure
  temperatures and fans (FDM), UV LED and vat temperatures (resin), as far as
  the printer reports them.
- Scene triggers: print finished, print error, print paused.
- The "Control an Elegoo print" scene action (pause, resume, stop), off by
  default, sent only after a fresh state that allows it. No print start, no
  axis move.
- A WebSocket per printer with the SDCP heartbeat, a watchdog, reconnection
  with growing delays (up to 5 minutes), bounded and validated messages.
- SDCP V1 printers (Saturn 3 Ultra, MQTT) are recognised and named as not
  supported in the status, without a connection attempt.
- Reachability on the transport badge, states within the Gladys rate limit,
  temperatures and fans spaced by a minute.

[Unreleased]: https://github.com/LM1LC3N7/gladys-elegoo/commits/main
