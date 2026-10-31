/** Pure helpers for the price-page connector queue badges (kept free of React so they can be unit-tested). */

/** Statuses meaning "a reading is waiting or in progress". */
const ACTIVE = new Set(["queued", "running"]);
/** Statuses that do not mean a reading has finished, even though they are not active. */
const NOT_FINISHED = new Set(["rate_limited", "unavailable", "disabled"]);

export function isActiveStatus(status: string): boolean {
  return ACTIVE.has(status);
}

/**
 * True when a product that was queued or running has left the queue with an
 * outcome that can have changed its displayed price. Throttled or unavailable
 * answers say nothing about the reading, so they must not trigger a reload.
 */
export function readingFinished(previous: string | undefined, status: string): boolean {
  return previous !== undefined && ACTIVE.has(previous) && !ACTIVE.has(status) && !NOT_FINISHED.has(status);
}
