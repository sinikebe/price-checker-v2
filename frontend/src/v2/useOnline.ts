import { useSyncExternalStore } from "react";

function subscribe(changed: () => void) {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => { window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
}

/**
 * Whether the browser is online. Offline, the app is read only: baskets and lists can be read and
 * the lists ticked; everything else waits for the connection.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
