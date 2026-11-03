import type { BasketItem } from "./v2-basket-storage";
import type { SharedSettings } from "./v2-shared-basket";
import { lineRef } from "./v2-shared-basket";

const PATH = "/api/v2/demo-basket";

async function failure(response: Response, fallback: string): Promise<Error> {
  const data: unknown = await response.json().catch(() => null);
  const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
  return new Error(typeof detail === "string" ? detail : response.status === 401 ? "Connectez-vous." : fallback);
}

/** The demo basket an administrator saved (`demo` of the response), or null when the app shows its own. */
export async function readDemoBasket(signal?: AbortSignal): Promise<unknown> {
  // "no-cache": the browser asks again each time, and the server answers 304 when nothing changed.
  const response = await fetch(PATH, { credentials: "same-origin", cache: "no-cache", signal });
  if (!response.ok) throw await failure(response, "Panier de démonstration indisponible.");
  const data = await response.json() as { demo?: unknown };
  return data.demo ?? null;
}

/** Make this basket the demo basket: the server reads the current prices of its articles itself. */
export async function saveDemoBasket(title: string, items: readonly BasketItem[], settings: Omit<SharedSettings, "checked">) {
  const response = await fetch(PATH, {
    method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      lines: items.map(item => ({ line: lineRef(item), quantity: item.quantity ?? null, disabled: item.disabled === true })),
      settings: { ...settings, stores_off: settings.stores_off.slice(0, 50) },
    }),
  });
  if (!response.ok) throw await failure(response, "Le panier de démonstration n’a pas pu être enregistré. Réessayez.");
  return await response.json() as { title: string; saved_at: string; items: number; products: number };
}

/** Back to the app's own example. */
export async function removeDemoBasket() {
  const response = await fetch(PATH, { method: "DELETE", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response, "Le panier de démonstration n’a pas pu être retiré. Réessayez.");
}
