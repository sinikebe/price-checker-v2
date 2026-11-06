/**
 * Browser-storage keys that belong to one account (pure, so it can be unit-tested).
 *
 * Keys embed the numeric user id. A key must therefore be matched on the whole id: matching the
 * start of `v2:product:new:3` would also take `v2:product:new:30` and `v2:product:new:31:ean:...`,
 * which belong to other accounts that share the browser.
 */
export function accountLocalKeys(keys: readonly string[], userId: number, exactKeys: readonly string[] = []): string[] {
  const id = String(userId);
  const drafts = draftKeys(id);
  const own = new Set([...drafts.exact, `v2:auth:offline-user:${id}`, `v2:mode:${id}`, `v2:site-filter:${id}`, ...exactKeys]);
  const prefixes = [...drafts.prefixes, `v2:prices:user:${id}:`];
  return keys.filter(key => own.has(key)
    || prefixes.some(prefix => key.startsWith(prefix))
    || (key.startsWith("v2:basket:") && key.endsWith(":" + id)));
}

/** The account's unsent work: new products and recipes, and its edits, drafts and proposals. */
function draftKeys(id: string) {
  return {
    exact: [`v2:product:new:${id}`, `v2:recipe:new:${id}`],
    prefixes: [
      `v2:product:new:${id}:`, `v2:product:edit:${id}:`, `v2:product:draft:${id}:`,
      `v2:recipe:new:${id}:`, `v2:recipe:edit:${id}:`, `v2:recipe:proposal:${id}:`,
    ],
  };
}

/**
 * What signing out removes from this browser: the account's private data that another person using
 * the device should not find (shared basket copies and their unsent changes, drafts, the account kept
 * for offline use). The personal
 * basket and its settings stay, as before: they are this device's basket, shown only to the account.
 */
export function logoutLocalKeys(keys: readonly string[], userId: number): string[] {
  const id = String(userId);
  const drafts = draftKeys(id);
  const own = new Set([...drafts.exact, `v2:basket:shared:${id}`, `v2:auth:offline-user:${id}`]);
  const prefixes = drafts.prefixes;
  const shared = /^v2:basket:shared-(?:state|queue|prices):\d+:(\d+)$/;
  return keys.filter(key => own.has(key) || prefixes.some(prefix => key.startsWith(prefix)) || shared.exec(key)?.[1] === id);
}

/** What signing out would erase that was never sent: changes to a shared basket, and drafts. */
export function unsentAtLogout(storage: { key: (index: number) => string | null; length: number; getItem: (key: string) => string | null }, userId: number): { changes: number; drafts: number } {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key) keys.push(key); }
  let changes = 0, drafts = 0;
  for (const key of logoutLocalKeys(keys, userId)) {
    if (/^v2:basket:shared-queue:/.test(key)) {
      try { const value: unknown = JSON.parse(storage.getItem(key) ?? "[]"); changes += Array.isArray(value) ? value.length : 0; } catch { /* unreadable: nothing to count */ }
    } else if (/^v2:(?:product|recipe):/.test(key)) drafts += 1;
  }
  return { changes, drafts };
}
