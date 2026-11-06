import { PWA_RECIPES_READY_KEY } from "../pwa/cache-keys";
import type { RecipeInput } from "./v2-recipes-api";

/*
 * What the recipe pages keep in this browser. Storage can be blocked or full: every access is
 * guarded, so that a failure here never turns a saved recipe into an error (which would invite a
 * second submission) nor hides the page's own error message.
 */

/** The recipe being written, kept until it is saved. */
export type LocalCopy = { form: RecipeInput; revision: number | null; private?: boolean };

export function readLocalCopy(key: string): LocalCopy | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** False when the browser refused to keep the copy. */
export function saveLocalCopy(key: string, copy: LocalCopy): boolean {
  try { localStorage.setItem(key, JSON.stringify(copy)); return true; } catch { return false; }
}

export function forgetLocalCopy(key: string): void {
  try { localStorage.removeItem(key); } catch { /* nothing was stored */ }
}

/** The offline copy of the public recipes is complete, even when it holds none. */
export function offlineRecipesReady(): boolean {
  try { return localStorage.getItem(PWA_RECIPES_READY_KEY) === "1"; } catch { return false; }
}
