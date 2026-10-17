// -----------------------------------------------------------------------------
// Scene trigger events from two successive statuses of a printer (pure).
//
// Only changes seen while connected count: the first status after a
// (re)connection is a baseline, so a printer found already "completed" or
// "paused" fires nothing.
// -----------------------------------------------------------------------------

import { SCENE_TRIGGERS } from './constants.js';
import { ACTIVE_PHASES } from './sdcp/protocol.js';

/** The trigger keys `next` fires after `previous` (in that order, each at most once). */
export function jobEvents(previous, next) {
  if (!previous || !next) {
    return [];
  }
  const events = [];
  if (next.phase === 'completed' && ACTIVE_PHASES.has(previous.phase)) {
    events.push(SCENE_TRIGGERS.FINISHED);
  }
  const newErrorNumber =
    (next.errorNumber ?? 0) > 0 && next.errorNumber !== (previous.errorNumber ?? 0);
  if ((next.phase === 'error' && previous.phase !== 'error') || newErrorNumber) {
    events.push(SCENE_TRIGGERS.ERROR);
  }
  if (next.phase === 'paused' && previous.phase !== 'paused') {
    events.push(SCENE_TRIGGERS.PAUSED);
  }
  return events;
}
