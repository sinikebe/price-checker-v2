/** Which mode an account uses on this device (pure, so it can be unit-tested). See `AppMode` in v2-site-nav. */
import type { AppMode } from "./v2-site-nav";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** The device key that remembers the expert mode of one account. */
export const appModeKey = (userId: number) => `v2:mode:${userId}`;

/** The mode in use: expert only for a signed-in account that chose it on this device; shopping otherwise. */
export function readAppMode(storage: Storage | null, userId: number | null): AppMode {
  if (!userId || !storage) return "shopping";
  try { return storage.getItem(appModeKey(userId)) === "expert" ? "expert" : "shopping"; }
  catch { return "shopping"; }
}

/** Remembers the choice; shopping, the default, is stored as nothing. */
export function writeAppMode(storage: Storage | null, userId: number, mode: AppMode) {
  if (!storage) return;
  try {
    if (mode === "expert") storage.setItem(appModeKey(userId), "expert");
    else storage.removeItem(appModeKey(userId));
  } catch { /* storage unavailable: the choice lasts until the page is reloaded */ }
}
