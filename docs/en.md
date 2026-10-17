# Elegoo 3D printers

Follow your Elegoo 3D printers in Gladys, on your local network, without the
Elegoo cloud: print state, progress, layers, time elapsed and remaining, file
name, temperatures and fans, scene triggers when a print finishes, fails or is
paused, and, if you allow it, pause / resume / stop from a scene.

Unofficial integration, not affiliated with Elegoo.

> **Never tested on a real printer.** This first version has never been
> tested on a real printer: it follows Elegoo's public SDCP protocol and the
> Home Assistant integration `elegoo-homeassistant`, and was checked against
> simulated printers only. Feedback is welcome on the Gladys forum.

## Compatible printers

The Elegoo printers that speak **SDCP V3** over a local WebSocket (port 3030):

- resin: Saturn 4 Ultra, Saturn 4 Ultra 16K, Mars 5 Ultra (and the other SDCP
  V3 Saturn / Mars models);
- FDM: Centauri Carbon.

Not supported: the Saturn 3 Ultra and the other printers that speak SDCP V1
over MQTT (the integration recognises them and says so in its status), the
Centauri Carbon 2 (another protocol), and the printers without network.

## Setup

1. Give each printer a **fixed IP address** in your router (DHCP reservation).
   The address is shown on the printer screen, in the network settings.
2. In Gladys, open the Elegoo integration, type the addresses in **IP
   addresses of the printers** (separated by commas), and save. This is the
   reliable way: the integration runs in a container that does not hear the
   network broadcasts.
3. Or click **Find the printers**: Gladys sends the SDCP discovery message
   (UDP port 3000) on your network and lists the printers that answer. If it
   finds nothing, type the addresses.
4. The printers appear in the **Discovery** tab once they sent their state:
   add them.

A printer accepts only a few connections at once (Elegoo app, slicer, Home
Assistant...): if it does not answer, close one of them.

## What Gladys shows

| Feature                      | Notes                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Print state                  | Idle, Preparing, Printing, Pausing, Paused, Stopping, Stopped, Completed, Error, Busy |
| Machine state                | What the printer does (printing, file transfer, self-test, leveling...)               |
| Progress (%)                 | Reported by the printer, or computed from the layers                                  |
| Current layer, total layers  |                                                                                       |
| Time elapsed, time remaining | In minutes                                                                            |
| File                         | The file being printed (the last one when idle)                                       |
| Error, error code            | 0 and "None" when all is well                                                         |
| Temperatures                 | FDM: nozzle, bed, enclosure; resin: UV LEDs, and the vat if the printer has a sensor  |
| Fans                         | FDM: model, auxiliary and enclosure fans (%)                                          |

Each printer only gets the temperatures and fans it reports. Temperatures and
fans are sent at most once a minute; the other values as soon as they change.
The printers send their changes by themselves, and Gladys also asks for their
state every **Refresh interval** (30 s by default).

The **Language of the names and states** applies to the feature names of the
printers added afterwards and to the texts (print state, error).

## Scenes

Triggers, each with the printer to watch:

- **Elegoo print finished**: a print seen in progress ends completed (once per
  print). Variable: `file`.
- **Elegoo print error**: an error status, a print error, or an error message
  of the printer. Variables: `file`, `error`, `error_code`.
- **Elegoo print paused**: the print goes into pause, whoever paused it.
  Variable: `file`.

Only changes seen while Gladys is connected count: a print that finished while
the printer or Gladys was off fires nothing.

## Print control (off by default)

The **Control an Elegoo print** scene action pauses, resumes or stops the
current print. It is refused until you tick **Allow pause, resume and stop
from Gladys**: anyone who can edit the scenes of your Gladys could then stop a
print.

Safety rules:

- Gladys **never starts a print** and **never moves the axes**: those commands
  do not exist in the integration.
- Before each command, the printer is asked for its state. Without a fresh
  answer, nothing is sent. The command is also refused if it does not fit:
  pause only while printing, resume only while paused, stop only during a
  print.
- One command at a time per printer. A command the printer does not confirm
  within 5 seconds is reported as such: check the printer, it may have been
  applied.

## Troubleshooting

- **"No answer yet from ..."**: the printer is off, the address is wrong, or
  all its connections are taken. Check that you can reach it from the Gladys
  machine. The integration tries again by itself, waiting a little longer each
  time (up to 5 minutes).
- **The search finds nothing**: type the addresses; the discovery depends on
  the network between Gladys and the printers.
- **A printer changed address**: replace the old address with the new one in
  the configuration; the printer is recognised by its board id, its device
  and history are kept.
- To forget a printer, remove its address and delete its device.

## Privacy

Everything stays on your local network: Gladys talks to the printers directly
(WebSocket on port 3030, UDP on port 3000). Nothing is sent to Elegoo or to
anyone else.
