// -----------------------------------------------------------------------------
// Identity of a typed address: "M99999" sent in UNICAST to <host>:3000, the
// printer answers to the sender. Unicast crosses the bridge network of the
// container in both directions (a broadcast does not: the search of the
// configuration screen goes through the Gladys core instead, see src/app.js).
// -----------------------------------------------------------------------------

import { createSocket } from 'node:dgram';
import { LIMITS, SDCP, TIMINGS } from '../constants.js';
import { parseDiscovery } from './protocol.js';

/**
 * Resolves with the identity the printer at `host` answers, or undefined
 * (no answer within the timeout, or an answer that is not SDCP).
 */
export function probe(host, { timeout = TIMINGS.probeTimeout, create = createSocket } = {}) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let done = false;
    const finish = (identity) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
      resolve(identity);
    };
    try {
      socket = create({ type: host.includes(':') ? 'udp6' : 'udp4' });
    } catch {
      finish(undefined);
      return;
    }
    socket.on('error', () => finish(undefined));
    socket.on('message', (datagram) => {
      if (datagram.length > LIMITS.datagramBytes) return;
      const identity = parseDiscovery(datagram);
      if (identity) finish(identity);
    });
    timer = setTimeout(() => finish(undefined), timeout);
    socket.send(Buffer.from(SDCP.discoveryMessage), SDCP.discoveryPort, host, (err) => {
      if (err) finish(undefined);
    });
  });
}
