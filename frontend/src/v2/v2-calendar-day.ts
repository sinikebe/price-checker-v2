// No imports: tests load this module on its own.

/**
 * The time of a reading: a calendar day ("2026-11-01") is taken at local noon, so it shows as that same day
 * in every time zone (Date.parse reads a bare day as UTC midnight, the day before west of UTC). A full
 * timestamp is read as it is.
 */
export const readingTime = (value: string): number =>
  new Date(value.length === 10 ? value + "T12:00:00" : value).getTime();
