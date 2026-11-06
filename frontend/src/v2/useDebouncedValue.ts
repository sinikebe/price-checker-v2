import { useEffect, useState } from "react";

/**
 * `value` once it has stayed the same for `ms` milliseconds: a search sends one request after a
 * pause in the typing rather than one per key. The first value is returned at once.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return current;
}
