import { useEffect, useState } from "react";
import { directoryStoreLabel, type DirectoryStore } from "./v2-site-filter";

/**
 * Store names from the public directory, read once and only when `needed`: for the stores of a shared
 * filter that another member chose and that the basket's prices do not name.
 */
export function useStoreDirectoryLabels(needed: boolean): ReadonlyMap<number, string> | null {
  const [labels, setLabels] = useState<ReadonlyMap<number, string> | null>(null);
  useEffect(() => {
    if (!needed || labels) return;
    const controller = new AbortController();
    fetch("/api/v2/stores", { credentials: "same-origin", signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<DirectoryStore[]> : Promise.reject(new Error("directory")))
      .then(stores => setLabels(new Map(stores.map(store => [store.id, directoryStoreLabel(store)]))))
      .catch(() => undefined);
    return () => controller.abort();
  }, [needed, labels]);
  return labels;
}
