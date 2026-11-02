/** The basket page's side of the browser extension: ask what needs reading, hand it over, record what comes back.
 *  The extension talks to this page only through window messages; the server never trusts it beyond what
 *  the logged-in administrator could do (a checked reading, filed under the right store). */
export type PlanItem = { product_id: number; ean: string; brand: string; name: string };
export type PlanStore = { id: number; name: string; city: string | null; postal_code: string | null; retailer: string };
export type Plan = { store: PlanStore | null; items: PlanItem[]; reason: string | null };
export type ProgressItem = {
  product_id: number; ean: string; outcome: "price" | "not_sold" | "error" | "challenge";
  price?: number; available?: boolean; title?: string | null; url?: string | null; storeSlug?: string | null; storeLabel?: string | null; detail?: string;
};
export type ExtensionEvent =
  | { type: "started"; total: number } | { type: "progress"; done: number; total: number; item: ProgressItem }
  | { type: "needs-human" } | { type: "resumed" } | { type: "done" } | { type: "aborted"; reason: string; store?: string | null };
export type ExtensionInfo = { version: string; adapters: string[] };

export const ADAPTER = "carrefour";
const EAN = /^\d{8,14}$/;

/** The message that starts a job: only what the extension needs to read, never a credential. */
export function jobMessage(id: string, plan: Plan): { source: "pc-app"; type: "refresh"; id: string; adapter: string; storeHint: string; items: { product_id: number; ean: string }[] } | null {
  if (!plan.store?.city || !plan.items.length) return null;
  return { source: "pc-app", type: "refresh", id, adapter: ADAPTER, storeHint: plan.store.city,
    items: plan.items.map(item => ({ product_id: item.product_id, ean: item.ean })) };
}

/** What to record for one reading, or null when it says nothing to record (an error, a check). */
export function readingBody(plan: Plan, item: ProgressItem): Record<string, unknown> | null {
  if (!plan.store || !Number.isSafeInteger(item.product_id) || !EAN.test(item.ean)) return null;
  const base = { adapter: ADAPTER, store_id: plan.store.id, product_id: item.product_id, ean: item.ean };
  if (item.outcome === "not_sold") return { ...base, outcome: "not_sold" };
  if (item.outcome !== "price" || typeof item.price !== "number" || !(item.price > 0 && item.price < 10000)) return null;
  const url = typeof item.url === "string" && item.url.startsWith("https://www.carrefour.fr/") && !/\s/.test(item.url) ? item.url : null;
  return { ...base, outcome: "price", price: Math.round(item.price * 100) / 100, available: item.available !== false, source_url: url, title: item.title ?? null };
}

/** A message from the extension, accepted only when it is well formed. */
export function parseEvent(data: unknown, id: string): ExtensionEvent | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "pc-ext" || message.id !== id || typeof message.type !== "string") return null;
  switch (message.type) {
    case "started": return Number.isSafeInteger(message.total) ? { type: "started", total: message.total as number } : null;
    case "progress": {
      const item = message.item as Record<string, unknown> | undefined;
      if (!item || !Number.isSafeInteger(item.product_id) || typeof item.ean !== "string"
        || !["price", "not_sold", "error", "challenge"].includes(String(item.outcome))
        || !Number.isSafeInteger(message.done) || !Number.isSafeInteger(message.total)) return null;
      return { type: "progress", done: message.done as number, total: message.total as number, item: item as unknown as ProgressItem };
    }
    case "needs-human": case "resumed": case "done": return { type: message.type };
    case "aborted": return { type: "aborted", reason: typeof message.reason === "string" ? message.reason.slice(0, 40) : "unknown",
      store: typeof message.store === "string" ? message.store.slice(0, 80) : null };
    default: return null;
  }
}

export function abortText(reason: string, plan: Plan, seen?: string | null): string {
  const mine = plan.store ? `${plan.store.name}${plan.store.city ? ` (${plan.store.city})` : ""}` : "le magasin de l’application";
  switch (reason) {
    case "wrong_store": return `Le magasin choisi sur carrefour.fr${seen ? ` (${seen})` : ""} n’est pas celui de l’application : ${mine}. Choisissez votre drive sur carrefour.fr puis relancez.`;
    case "errors": return "Trois lectures de suite ont échoué : carrefour.fr a peut-être changé. Rien n’a été enregistré pour ces produits.";
    case "cancelled": return "Lecture interrompue.";
    case "extension_stopped": return "L’extension s’est arrêtée avant la fin.";
    case "busy": return "L’extension lit déjà un autre panier.";
    default: return "L’extension a interrompu la lecture.";
  }
}

export async function detectExtension(timeoutMs = 700): Promise<ExtensionInfo | null> {
  if (typeof window === "undefined") return null;
  const id = "ping-" + Math.random().toString(36).slice(2, 10);
  return new Promise(resolve => {
    const done = (value: ExtensionInfo | null) => { window.removeEventListener("message", listen); window.clearTimeout(timer); resolve(value); };
    const listen = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (event.source !== window || event.origin !== window.location.origin || !data || data.source !== "pc-ext" || data.type !== "pong" || data.id !== id) return;
      done({ version: String(data.version ?? "").slice(0, 20), adapters: Array.isArray(data.adapters) ? data.adapters.filter((a): a is string => typeof a === "string").slice(0, 10) : [] });
    };
    const timer = window.setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", listen);
    window.postMessage({ source: "pc-app", type: "ping", id }, window.location.origin);
  });
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export const requestPlan = (productIds: number[]) => call<Plan>("/api/v2/extension/plan", { adapter: ADAPTER, product_ids: productIds });
export const recordReading = (body: Record<string, unknown>) => call<{ saved: boolean; reason: string | null }>("/api/v2/extension/readings", body);

/** Hand a job to the extension and follow it until it ends. `cancel` asks it to stop after the current product. */
export function runJob(plan: Plan, onEvent: (event: ExtensionEvent) => void): { finished: Promise<void>; cancel: () => void } {
  const id = "job-" + Math.random().toString(36).slice(2, 12);
  const message = jobMessage(id, plan);
  let listen: (event: MessageEvent) => void = () => undefined;
  const finished = new Promise<void>(resolve => {
    if (!message) { onEvent({ type: "aborted", reason: "invalid_job" }); resolve(); return; }
    listen = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const parsed = parseEvent(event.data, id);
      if (!parsed) return;
      onEvent(parsed);
      if (parsed.type === "done" || parsed.type === "aborted") { window.removeEventListener("message", listen); resolve(); }
    };
    window.addEventListener("message", listen);
    window.postMessage(message, window.location.origin);
  });
  return { finished, cancel: () => window.postMessage({ source: "pc-app", type: "cancel", id }, window.location.origin) };
}
