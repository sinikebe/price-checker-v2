import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const load = async file => {
  const source = readFileSync(new URL(`../src/v2/${file}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
};
const search = await load("v2-catalogue-search.ts");
const api = await load("v2-catalogue-api.ts");
const { SEARCH_CACHE_SIZE, SEARCH_MIN_CHARS, collapse, filterProducts, findCovering, isBarcode, matchesQuery, normalizeQuery, remember, resolveView, sameBarcode, scopeKey } = search;
const parity = JSON.parse(readFileSync(new URL("./fixtures/search-parity.json", import.meta.url), "utf8"));

const NO_SCOPE = { category: "", storeId: 0 };
const ids = list => list.map(item => item.id).sort((a, b) => a - b);
// What the API sends: the product model fills the fields a stored product lacks with empty strings.
const asServed = product => ({ id: product.id, data: { brand: "", name: "", commercial_name: "", quantity: "", ean: "", ...product.data } });

test("the browser gives the shared fixture's answers, on the stored fields and on what the API serves", () => {
  for (const shape of [product => product, asServed]) {
    const products = parity.products.map(shape);
    for (const { q, ids: expected, note } of parity.queries)
      assert.deepEqual(ids(filterProducts(products, q)), expected, `${q} (${note ?? ""})`);
  }
});

test("a text is compared collapsed, trimmed and in lower case", () => {
  assert.equal(collapse("  lait \t  demi \n"), "lait demi");
  assert.equal(normalizeQuery("  LAIT  Demi "), "lait demi");
  assert.equal(normalizeQuery("ÉCLAIR"), "éclair");
  assert.equal(normalizeQuery(""), "");
});

test("an empty text matches everything", () => {
  assert.equal(filterProducts(parity.products, "   ").length, parity.products.length);
  assert.equal(matchesQuery(parity.products[0], ""), true);
});

test("a longer text only ever keeps matches of the shorter one it contains: filtering a list locally is safe", () => {
  const products = parity.products.map(asServed);
  const texts = parity.queries.map(item => item.q).filter(text => normalizeQuery(text).length >= SEARCH_MIN_CHARS);
  for (const long of texts) {
    const wanted = normalizeQuery(long);
    for (let start = 0; start < wanted.length; start++) for (let end = start + SEARCH_MIN_CHARS; end <= wanted.length; end++) {
      const short = wanted.slice(start, end);   // every substring of every text, not only prefixes
      assert.deepEqual(ids(filterProducts(filterProducts(products, short), long)), ids(filterProducts(products, long)), `${short} -> ${long}`);
    }
  }
});

test("barcodes: eight, twelve, thirteen or fourteen digits, with or without leading zeros", () => {
  for (const code of ["12345678", "123456789012", "3428272630010", "03428272630010", " 3428272630010 "]) assert.equal(isBarcode(code), true, code);
  for (const text of ["", "1234567", "123456789", "12345678901234567", "34282726300a0", "lait", "1234 5678"]) assert.equal(isBarcode(text), false, text);
  assert.equal(sameBarcode("3428272630010", "03428272630010"), true);
  assert.equal(sameBarcode("3428272630010", "3428272630011"), false);
});

test("a cached complete list answers any longer text that contains its text, within the same filters", () => {
  const entry = { query: "lait", scope: NO_SCOPE, items: [{ id: 1 }, { id: 2 }] };
  for (const text of ["lait", "lait demi", "LAIT  entier", "du lait", "lait de coco bio"]) assert.equal(findCovering([entry], text, NO_SCOPE), entry, text);
  for (const text of ["lai", "la", "lit", "beurre", ""]) assert.equal(findCovering([entry], text, NO_SCOPE), null, text);
  assert.equal(findCovering([entry], "lait demi", { category: "Lait", storeId: 0 }), null);
  assert.equal(findCovering([entry], "lait demi", { category: "", storeId: 4 }), null);
  assert.equal(findCovering([entry], "lait demi", { category: "  ", storeId: 0 }) , entry, "blank filters are no filters");
});

test("the smallest covering list is used, and the longest text on a tie", () => {
  const wide = { query: "la", scope: NO_SCOPE, items: [1, 2, 3, 4].map(id => ({ id })) };
  const narrow = { query: "lait", scope: NO_SCOPE, items: [{ id: 1 }, { id: 2 }] };
  const same = { query: "ait", scope: NO_SCOPE, items: [{ id: 1 }, { id: 2 }] };
  assert.equal(findCovering([wide, narrow], "lait demi", NO_SCOPE), narrow);
  assert.equal(findCovering([wide, same, narrow], "lait demi", NO_SCOPE), narrow);
  assert.equal(findCovering([narrow, wide], "la", NO_SCOPE), wide);
});

test("the cache replaces the same search, ignores filter case, and drops the oldest beyond its size", () => {
  const entry = (query, category = "") => ({ query, scope: { category, storeId: 0 }, items: [{ id: query.length }] });
  let cache = remember([], entry("lait"));
  cache = remember(cache, entry("beurre"));
  cache = remember(cache, { ...entry("lait"), items: [{ id: 99 }] });
  assert.deepEqual(cache.map(item => item.query), ["beurre", "lait"]);
  assert.equal(cache[1].items[0].id, 99);
  assert.equal(remember(cache, entry("lait", "Lait")).length, 3, "another filter is another list");
  assert.equal(remember(cache, entry("LAIT".toLowerCase(), "LAIT")).length, 3);
  let many = [];
  for (let n = 0; n < SEARCH_CACHE_SIZE + 5; n++) many = remember(many, entry("q" + String(n).padStart(3, "0")));
  assert.equal(many.length, SEARCH_CACHE_SIZE);
  assert.equal(many.at(-1).query, "q" + String(SEARCH_CACHE_SIZE + 4).padStart(3, "0"));
  assert.equal(many[0].query, "q005");
  assert.equal(scopeKey({ category: " Lait ", storeId: 3 }), scopeKey({ category: "lait", storeId: 3 }));
});

test("what the page shows follows from what is known", () => {
  const cache = [{ query: "lait", scope: NO_SCOPE, items: parity.products.map(asServed).filter(item => [1, 2, 5, 7, 8].includes(item.id)) }];
  const base = { scope: NO_SCOPE, cache: [], outcome: null, limitedFor: null };
  assert.deepEqual(resolveView({ ...base, query: "" }), { kind: "idle", short: false });
  assert.deepEqual(resolveView({ ...base, query: " l " }), { kind: "idle", short: true });
  assert.deepEqual(resolveView({ ...base, query: "lait" }), { kind: "loading" });
  const local = resolveView({ ...base, cache, query: "lait demi" });
  assert.equal(local.kind, "list"); assert.equal(local.local, true); assert.deepEqual(ids(local.items), [1]);
  assert.deepEqual(resolveView({ ...base, cache, query: "lait zzz" }), { kind: "list", items: [], local: true });
  const many = { kind: "many", total: 142, max: 50 };
  assert.deepEqual(resolveView({ ...base, query: "chocolat", outcome: many }), many);
  const failed = { kind: "error", message: "boom" };
  assert.deepEqual(resolveView({ ...base, query: "chocolat", outcome: failed }), failed);
  assert.deepEqual(resolveView({ ...base, query: "chocolat", limitedFor: 30 }), { kind: "limited", retryAfter: 30 });
});

test("when the server refuses, a list already held still answers; and a covered text needs no request", () => {
  const cache = [{ query: "lait", scope: NO_SCOPE, items: [{ id: 1, data: { name: "Lait demi" } }] }];
  const view = resolveView({ query: "lait demi", scope: NO_SCOPE, cache, outcome: null, limitedFor: 30 });
  assert.equal(view.kind, "list");
  assert.notEqual(resolveView({ query: "lait demi", scope: NO_SCOPE, cache, outcome: null, limitedFor: null }).kind, "loading");
  assert.equal(resolveView({ query: "beurre", scope: NO_SCOPE, cache, outcome: null, limitedFor: null }).kind, "loading");
});

test("the wait suggested by the server is kept between one second and an hour", () => {
  assert.equal(api.retryAfterSeconds("17"), 17);
  assert.equal(api.retryAfterSeconds("2.2"), 3);
  assert.equal(api.retryAfterSeconds("99999"), 3600);
  for (const bad of [null, "", "abc", "0", "-5"]) assert.equal(api.retryAfterSeconds(bad), 60, String(bad));
  assert.equal(new api.RateLimitedError(12).retryAfter, 12);
});
