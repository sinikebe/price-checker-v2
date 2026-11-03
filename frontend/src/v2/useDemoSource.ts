import { useEffect, useSyncExternalStore } from "react";
import { builtinDemo, savedDemo, type DemoSource } from "./v2-basket-demo";
import { readDemoBasket } from "./v2-demo-basket-api";

let current: DemoSource | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load() {
  loading ??= readDemoBasket()
    .then(value => savedDemo(value))
    // Offline, refused or unexpected: the app's own example.
    .catch(() => null)
    .then(saved => {
      current = saved ?? builtinDemo(new Date());
      for (const listener of listeners) listener();
    });
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The demo basket shown on this installation (null while it loads): the saved one, or the app's example. */
export function useDemoSource(): DemoSource | null {
  const source = useSyncExternalStore(subscribe, () => current);
  useEffect(load, []);
  return source;
}

/** Read the demo again, after an administrator saved or removed one. */
export function reloadDemoSource() {
  loading = null;
  load();
}
