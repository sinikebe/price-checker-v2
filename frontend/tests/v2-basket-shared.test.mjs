import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-shared-basket.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const {
  DEFAULT_SETTINGS, activityText, forgetSharedCache, readSharedCache, sharedQueueKey, sharedStateKey, writeSharedQueue, writeSharedState, applyOps, applySettings, diffOps, inviteFromHash, inviteUrl, keepPendingInvite, lineRef,
  newFromOthers, queueOps, readSharedId, sharedItems, sharedSettings, takePendingInvite, wireOps, writeSharedId, tickOps, allowedOffline, sharedSnapshot, readSharedPrices, writeSharedPrices,
} = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

// The same key as the browser basket (basketItemKey in v2-basket-storage.ts).
const keyOf = item => "kind" in item
  ? item.kind === "group" ? "group:" + item.name.toLocaleLowerCase("fr")
    : ["scope", item.department, item.family, item.name].map(part => part.toLocaleLowerCase("fr")).join(":")
  : "product:" + item.id;
const milk = { id: 7, revision: 2, data: { name: "Lait", brand: "Ferme" } };
const pasta = { kind: "group", name: "Pâtes" };
const rice = { kind: "scope", department: "Épicerie", family: "Riz", name: "Basmati" };
const line = (id, extra) => ({ id, kind: "group", label: "Pâtes", product_id: null, department: null, family: null,
  quantity: null, disabled: false, added_by: "alice", mine: false, created_at: "2026-11-02T10:00:00Z", product: null, ...extra });

test("server lines become basket items; a product withdrawn since is set apart", () => {
  const { items, lines, unavailable } = sharedItems([
    line(1, { kind: "product", label: "Ferme Lait", product_id: 7, product: { id: 7, revision: 2, data: milk.data }, quantity: { amount: "2", unit: "l" } }),
    line(2, { disabled: true }),
    line(3, { kind: "scope", label: "Basmati", department: "Épicerie", family: "Riz" }),
    line(4, { kind: "product", label: "Ancien", product_id: 9, product: null }),
  ]);
  assert.deepEqual(items, [
    { ...milk, quantity: { amount: "2", unit: "l" } },
    { ...pasta, disabled: true },
    rice,
  ]);
  assert.deepEqual(lines.map(item => item.id), [1, 2, 3]);
  assert.deepEqual(unavailable.map(item => item.id), [4]);
});

test("a member's edit becomes changes named by line, removals first", () => {
  const before = [milk, pasta, { ...rice, quantity: { amount: "1", unit: "kg" } }];
  const after = [{ ...pasta, disabled: true }, rice, { kind: "group", name: "Riz" }];
  const ops = diffOps(before, after, keyOf);
  assert.deepEqual(wireOps(ops), [
    { op: "remove", line: { kind: "product", product_id: 7 } },
    { op: "update", line: { kind: "group", name: "Pâtes" }, disabled: true },
    { op: "update", line: { kind: "scope", department: "Épicerie", family: "Riz", name: "Basmati" }, quantity: null },
    { op: "add", line: { kind: "group", name: "Riz" }, quantity: null, disabled: false },
  ]);
  assert.deepEqual(diffOps(before, before, keyOf), [], "nothing changed, nothing sent");
  assert.deepEqual(lineRef(milk), { kind: "product", product_id: 7 });
});

test("unconfirmed changes show at once and apply on top of a newer server state", () => {
  const mine = diffOps([pasta], [pasta, milk], keyOf);
  const quantity = diffOps([pasta, milk], [pasta, { ...milk, quantity: { amount: "3", unit: "l" } }], keyOf);
  // Another member added rice meanwhile: the server now has pasta and rice.
  const view = applyOps([pasta, rice], [...mine, ...quantity], keyOf);
  assert.deepEqual(view, [pasta, rice, { ...milk, quantity: { amount: "3", unit: "l" } }]);
  // The quantity set before the addition was confirmed is sent as an update of the same line.
  assert.deepEqual(wireOps(quantity), [{ op: "update", line: { kind: "product", product_id: 7 }, quantity: { amount: "3", unit: "l" } }]);
  // Adding what is already there keeps one line; removing clears it; clearing a quantity removes the field.
  assert.deepEqual(applyOps([pasta], mine.concat(mine), keyOf), [pasta, milk]);
  assert.deepEqual(applyOps([pasta, milk], diffOps([pasta, milk], [milk], keyOf), keyOf), [milk]);
  const cleared = applyOps([{ ...pasta, quantity: { amount: "1", unit: "kg" }, disabled: true }],
    diffOps([{ ...pasta, quantity: { amount: "1", unit: "kg" }, disabled: true }], [pasta], keyOf), keyOf);
  assert.deepEqual(cleared, [pasta]);
});

test("notices name what other members just added, not one's own lines", () => {
  const before = [line(1)];
  const after = [line(1), line(2, { label: "Lait", added_by: "bob" }), line(3, { label: "Beurre", mine: true, added_by: "me" })];
  assert.deepEqual(newFromOthers(before, after).map(item => item.id), [2]);
  assert.deepEqual(newFromOthers(null, after), [], "nothing to announce on the first read");
  assert.equal(activityText([line(2, { label: "Lait", added_by: "bob" })]), "bob a ajouté Lait.");
  assert.equal(activityText([line(2, { label: "Lait", added_by: "bob" }), line(4, { label: "Œufs", added_by: "bob" })]), "bob a ajouté Lait, Œufs.");
  assert.equal(activityText([line(2, { label: "A", added_by: "bob" }), line(4, { label: "B", added_by: "carol" }),
    line(5, { label: "C" }), line(6, { label: "D" }), line(7, { label: "E" })]), "Des membres ont ajouté A, B, C et 2 autres.");
  assert.equal(activityText([line(2, { added_by: null })]), "Un membre a ajouté Pâtes.");
  assert.equal(activityText([]), "");
});

test("invitation links and the shared basket open in this browser", () => {
  assert.equal(inviteFromHash("#rejoindre=12-abcdefghijklmnopqrstuv"), "12-abcdefghijklmnopqrstuv");
  for (const bad of ["#rejoindre=0-abcdefghijklmnopqrstuv", "#rejoindre=12-short", "#panier=abc", "", "#rejoindre=12-abcdefghijklmnopqrstuv<"])
    assert.equal(inviteFromHash(bad), null);
  const local = new Map(), session = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } });
  globalThis.localStorage = storage(local); globalThis.sessionStorage = storage(session);
  writeSharedId(5, 42);
  assert.equal(readSharedId(5), 42);
  assert.equal(readSharedId(6), null);
  assert.equal(readSharedId(null), null);
  assert.ok([...local.keys()].every(key => key.startsWith("v2:basket:") && key.endsWith(":5")), "removed with the account's local data");
  writeSharedId(5, null);
  assert.equal(readSharedId(5), null);
  keepPendingInvite("12-abcdefghijklmnopqrstuv");
  assert.equal(takePendingInvite(), "12-abcdefghijklmnopqrstuv");
  assert.equal(takePendingInvite(), null, "used once");
  session.set("v2:basket:pending-invite", "javascript:alert(1)");
  assert.equal(takePendingInvite(), null);
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readSharedId(5), null);
  assert.doesNotThrow(() => writeSharedId(5, 1));
  delete globalThis.localStorage; delete globalThis.sessionStorage;
});

test("settings every member shares: defaults, changes shown at once, one request for quick changes", () => {
  assert.deepEqual(sharedSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(sharedSettings({ settings: { compare: "unit", filters: { storeIds: [4] } } }),
    { ...DEFAULT_SETTINGS, compare: "unit", filters: { storeIds: [4], cities: [], departments: [] } }, "older or partial settings get the defaults");
  const ops = [{ op: "settings", patch: { advanced: true } }, { op: "settings", patch: { stores_off: ["12:drive"] } }];
  assert.deepEqual(applySettings(DEFAULT_SETTINGS, ops), { ...DEFAULT_SETTINGS, advanced: true, stores_off: ["12:drive"] });
  // Settings changes never touch the lines.
  assert.deepEqual(applyOps([pasta], ops, keyOf), [pasta]);
  // Quick settings changes join while not sent; an article change keeps its place in between.
  const add = diffOps([], [milk], keyOf)[0];
  assert.deepEqual(queueOps([], ops), [{ op: "settings", patch: { advanced: true, stores_off: ["12:drive"] } }]);
  assert.deepEqual(queueOps([ops[0]], [add, ops[1]]).map(op => op.op), ["settings", "add", "settings"]);
  assert.deepEqual(wireOps([ops[0]]), [{ op: "settings", advanced: true }]);
  assert.equal(inviteUrl("https://x.test", "3-abcdefghijklmnopqrstuv"), "https://x.test/v2/panier/partage#rejoindre=3-abcdefghijklmnopqrstuv");
});

test("a shared basket and its unsent changes are kept in the browser, for offline use", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
  const basket = { id: 9, name: "Courses", revision: 4, role: "member", owner: "alice", invite: "9-x", members: [], lines: [line(1)], limits: { lines: 100, members: 20 } };
  writeSharedState(5, basket);
  const ops = [...diffOps([], [milk], keyOf), { op: "settings", patch: { advanced: true } }];
  writeSharedQueue(9, 5, ops);
  assert.deepEqual(readSharedCache(9, 5), { basket: { ...basket, invite: null }, queue: JSON.parse(JSON.stringify(ops)) });
  assert.ok(!store.get(sharedStateKey(9, 5)).includes("9-x"), "the invitation link is never stored");
  assert.deepEqual(readSharedCache(9, 6), { basket: null, queue: [] }, "another account has none");
  assert.deepEqual(readSharedCache(null, 5), { basket: null, queue: [] });
  assert.ok([sharedStateKey(9, 5), sharedQueueKey(9, 5)].every(key => key.startsWith("v2:basket:") && key.endsWith(":5")));
  store.set(sharedQueueKey(9, 5), JSON.stringify([{ op: "drop table" }, { op: "remove", line: { kind: "group", name: "Pâtes" }, key: "group:pâtes" }]));
  assert.deepEqual(readSharedCache(9, 5).queue.map(op => op.op), ["remove"], "an unknown change is dropped");
  store.set(sharedStateKey(9, 5), JSON.stringify({ ...basket, id: 10 }));
  assert.equal(readSharedCache(9, 5).basket, null, "a copy of another basket is ignored");
  writeSharedQueue(9, 5, []);
  assert.equal(store.has(sharedQueueKey(9, 5)), false);
  forgetSharedCache(9, 5);
  assert.equal(store.size, 0);
  delete globalThis.localStorage;
});


test("ticks: one change per article, applied at once, the last one kept while waiting, the only change allowed offline", () => {
  assert.deepEqual(tickOps(["a", "b"], ["b", "c"]), [{ op: "tick", key: "a", on: false }, { op: "tick", key: "c", on: true }]);
  assert.deepEqual(tickOps(["a"], ["a"]), []);
  const settings = { ...DEFAULT_SETTINGS, checked: ["a", "b"] };
  assert.deepEqual(applySettings(settings, [{ op: "tick", key: "c", on: true }, { op: "tick", key: "a", on: false }, { op: "tick", key: "c", on: true }]).checked, ["b", "c"]);
  let queue = queueOps([], [{ op: "tick", key: "a", on: true }, { op: "settings", patch: { advanced: true } }]);
  queue = queueOps(queue, [{ op: "tick", key: "a", on: false }]);
  assert.deepEqual(queue, [{ op: "settings", patch: { advanced: true } }, { op: "tick", key: "a", on: false }], "the latest tick of an article replaces the one waiting");
  assert.deepEqual(wireOps([{ op: "tick", key: "group:pâtes", on: true }]), [{ op: "tick", key: "group:pâtes", on: true }]);
  assert.deepEqual(applyOps([{ kind: "group", name: "Pâtes" }], [{ op: "tick", key: "group:pâtes", on: true }], item => "group:" + item.name.toLocaleLowerCase("fr")),
    [{ kind: "group", name: "Pâtes" }], "a tick changes no article");
  assert.equal(allowedOffline({ op: "tick", key: "a", on: true }), true);
  for (const op of [{ op: "settings", patch: {} }, { op: "add", line: { kind: "group", name: "x" }, quantity: null, disabled: false, item: { kind: "group", name: "x" } },
    { op: "remove", line: { kind: "group", name: "x" }, key: "group:x" }, { op: "update", line: { kind: "group", name: "x" }, key: "group:x", disabled: true }])
    assert.equal(allowedOffline(op), false, op.op);
});

test("the browser copy keeps when the server last confirmed it, and the ticks waiting to be sent", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  const basket = { id: 4, name: "B", revision: 2, role: "member", owner: "ana", invite: "4-secret", members: [], lines: [], limits: { lines: 100, members: 20 } };
  writeSharedState(9, basket, "2026-11-03T12:00:00.000Z");
  writeSharedQueue(4, 9, [{ op: "tick", key: "group:pâtes", on: true }]);
  const cache = readSharedCache(4, 9);
  assert.equal(cache.basket.synced_at, "2026-11-03T12:00:00.000Z");
  assert.equal(cache.basket.invite, null, "the invitation is still never kept");
  assert.deepEqual(cache.queue, [{ op: "tick", key: "group:pâtes", on: true }]);
  delete globalThis.localStorage;
});


test("free text lines of a shared basket, and the prices a member fetched, matched to the articles they are now", () => {
  const line = (id, kind, label, extra = {}) => ({ id, kind, label, product_id: null, department: null, family: null, quantity: null, disabled: false, created_at: "", product: null, ...extra });
  const milk = line(1, "product", "Lait", { product_id: 7, product: { id: 7, revision: 1, data: { name: "Lait" } } });
  const text = line(2, "text", "Bougies");
  const pasta = line(3, "group", "Pâtes");
  const { items } = sharedItems([milk, text, pasta]);
  assert.deepEqual(items[1], { kind: "text", name: "Bougies" });
  assert.deepEqual(lineRef(items[1]), { kind: "text", name: "Bougies" });
  const keyOf = item => "kind" in item ? `${item.kind}:${item.name.toLocaleLowerCase("fr")}` : `product:${item.id}`;
  const prices = {
    fetched_at: "2026-11-03T10:00:00+00:00", fetched_by: "ana",
    content: { fetched_at: "2026-11-03T10:00:00+00:00", line_ids: [1, 3, 99], lines: [{ product_ids: [7], truncated: false }, { product_ids: [8, 9], truncated: true }, { product_ids: [5], truncated: false }],
      products: { 7: { id: 7 } }, prices: { 7: { latest_by_store: [] } } },
  };
  const snapshot = sharedSnapshot(prices, [milk, text, pasta], keyOf, { userId: 4, basketId: 12 });
  assert.deepEqual(snapshot.entries, { "product:7": { productIds: [7], truncated: false }, "group:pâtes": { productIds: [8, 9], truncated: true } },
    "the free text is not priced, and a line gone since is ignored");
  assert.equal(snapshot.fetchedAt, prices.fetched_at);
  assert.deepEqual([snapshot.userId, snapshot.basketId], [4, 12]);
  const replaced = sharedSnapshot(prices, [milk, line(4, "group", "Bougies")], keyOf, { userId: 4, basketId: 12 });
  assert.deepEqual(Object.keys(replaced.entries), ["product:7"], "an article added after the fetch waits for the next one");

  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  assert.equal(readSharedPrices(12, 4), null);
  writeSharedPrices(12, 4, prices);
  assert.deepEqual(readSharedPrices(12, 4), prices);
  store.set("v2:basket:shared-prices:12:4", JSON.stringify({ userId: 4, entries: {} }));
  assert.equal(readSharedPrices(12, 4), null, "an older per-member copy is not taken for the basket's prices");
  delete globalThis.localStorage;
});


test("a selection line becomes a basket item and back", () => {
  const line = { id: 9, kind: "selection", label: "Jus bio", product_id: null, department: null, family: null, quantity: null, disabled: false,
    created_at: "2026-11-04T10:00:00+00:00", product: null, spec: { include: [{ family: "Jus de fruits" }], exclude: [], words: ["bio"] } };
  const { items, unavailable } = sharedItems([line, { ...line, id: 10, label: "Vide", spec: undefined }]);
  assert.deepEqual(items, [{ kind: "selection", name: "Jus bio", include: [{ family: "Jus de fruits" }], exclude: [], words: ["bio"] }]);
  assert.equal(unavailable.length, 1);
  assert.deepEqual(lineRef(items[0]), { kind: "selection", name: "Jus bio", include: [{ family: "Jus de fruits" }], exclude: [], words: ["bio"] });
});
