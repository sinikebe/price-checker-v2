import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const load = async name => {
  const source = readFileSync(new URL(`../src/v2/${name}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
};
const { describeLog } = await load("v2-log-events.ts");
const { logQuery, defaultLogFilters, getLogs } = await load("v2-logs-api.ts");
const { sortEndpoints, partialPeriod, formatRate, formatCount, getStats, CONTRIBUTION_LABELS, PAGE_LABELS } = await load("v2-stats-api.ts");
const { pageKeyForPath, reportPage } = await load("v2-page-traffic.ts");
const nbsp = text => text.replace(/[  ]/g, " ");
const item = (event, data, extra = {}) => ({ id: 1, at: "2026-11-01T10:00:00+00:00", level: "info", source: "system", event, connector: null, data, ...extra });

test("each event reads as a sentence built from its code and numbers", () => {
  assert.equal(describeLog(item("system.started", { version: "0.1.106" })), "Serveur démarré (version 0.1.106).");
  assert.equal(describeLog(item("update.finished", { trigger: "scheduled", result: "updated", from_sha: "abcdef123456", to_sha: "1234567890ab" })),
    "Mise à jour planifiée : abcdef1 → 1234567.");
  assert.equal(describeLog(item("update.finished", { trigger: "manual", result: "failed", reason: "ci_not_passed" })),
    "Mise à jour demandée échouée : la CI n’a pas validé la version.");
  assert.equal(describeLog(item("update.finished", { trigger: "manual", result: "current" })), "Mise à jour demandée : le serveur était déjà à jour.");
  assert.equal(nbsp(describeLog(item("cache.cleaned", { trigger: "manual", result: "done", freed_bytes: 1_970_000_000 }))),
    "Nettoyage du cache (demandé depuis les paramètres) : 2.0 Go libérés.".replace(".", ","));
  assert.equal(describeLog(item("host.alert", { metric: "disk", pct: 85 })), "Alerte de l’hôte : stockage à 85 %.");
  assert.equal(describeLog(item("basket.prices.refused", { reason: "no_credits" })), "Récupération des prix du panier refusée : plus de crédit.");
  assert.equal(describeLog(item("basket.prices.fetched", { items: 3, products: 12, truncated: true, credits_left: 1 })),
    "Prix du panier récupérés : 3 articles, 12 produits (limite de taille atteinte) ; 1 crédit restant sur ce compte.");
});

test("an unlimited administrator fetch is journaled without a credit count", () => {
  assert.equal(describeLog(item("basket.prices.fetched", { items: 3, products: 12, truncated: false, unlimited: true })),
    "Prix du panier récupérés : 3 articles, 12 produits ; compte sans limite de crédits.");
});

test("connector events name the queue operation, only with the counts that matter", () => {
  const queue = { origin: "basket", requested: 12, queued: 2, fresh: 9, cooldown: 1, rate_limited: 0, other: 0 };
  assert.equal(describeLog(item("connector.queue.requested", queue, { source: "connector", connector: "auchan_houilles" })),
    "File d’attente (panier) : 12 produits demandés — 2 ajoutés, 9 déjà à jour, 1 en délai d’attente.");
  assert.equal(describeLog(item("connector.queue.requested", { ...queue, requested: 1, queued: 0, fresh: 0, cooldown: 0 })),
    "File d’attente (panier) : 1 produit demandé.");
  assert.equal(describeLog(item("connector.queue.added", { product_id: 130, origin: "page" })), "Produit 130 ajouté à la file (page de prix).");
  assert.equal(describeLog(item("connector.queue.dropped", { product_id: 130, reason: "fresh_elsewhere" })),
    "Produit 130 retiré de la file : un prix récent est arrivé d’une autre source.");
  assert.equal(describeLog(item("connector.reading.finished", { product_id: 5, outcome: "skipped" })), "Lecture du produit 5 : ignorée, le prix était déjà récent.");
  assert.equal(nbsp(describeLog(item("connector.price.saved", { product_id: 130, store_id: 115, price_cents: 259, channel: "drive" }))),
    "Prix enregistré : produit 130, magasin 115, 2,59 € (drive).");
  assert.equal(describeLog(item("connector.worker.failed", { error: "TimeoutError" })), "Erreur dans le connecteur (TimeoutError).");
});

test("an event this screen does not know yet is still shown, as its code and values", () => {
  assert.equal(describeLog(item("future.event", { count: 3, ok: true })), "future.event count=3 ok=true");
});

test("the filters become one query: every source when none is chosen, a cursor when paging", () => {
  assert.equal(logQuery(defaultLogFilters), "level=info&period=24h&limit=100");
  assert.equal(logQuery({ level: "error", sources: ["system", "connector"], connector: "auchan_houilles", period: "7d" }, "1793527200000000.42"),
    "level=error&period=7d&limit=100&source=system&source=connector&connector=auchan_houilles&before=1793527200000000.42");
});

test("the log request is a no-cache read and a failure is explained", async () => {
  let call;
  globalThis.fetch = async (url, init) => { call = [url, init.cache, init.credentials]; return { ok: true, json: async () => ({ items: [] }) }; };
  await getLogs(defaultLogFilters);
  assert.deepEqual(call, ["/api/v2/logs?level=info&period=24h&limit=100", "no-store", "same-origin"]);
  globalThis.fetch = async () => ({ ok: false });
  await assert.rejects(getLogs(defaultLogFilters), /n’a pas pu être chargé/);
  await assert.rejects(getStats("24h"), /n’ont pas pu être chargées/);
});

test("endpoints sort by the chosen column, busiest first on ties", () => {
  const endpoint = (route, requests, errors, average, perHour = requests / 2) => ({ method: "GET", route, requests, per_hour: perHour, client_errors: errors, server_errors: 0, average_ms: average, max_ms: average });
  const items = [endpoint("/b", 10, 0, 50), endpoint("/a", 10, 3, 20), endpoint("/c", 30, 1, 10)];
  assert.deepEqual(sortEndpoints(items, "requests").map(i => i.route), ["/c", "/a", "/b"]);
  assert.deepEqual(sortEndpoints(items, "errors").map(i => i.route), ["/a", "/c", "/b"]);
  assert.deepEqual(sortEndpoints(items, "average_ms").map(i => i.route), ["/b", "/a", "/c"]);
  assert.deepEqual(items.map(i => i.route), ["/b", "/a", "/c"], "the input is not reordered");
});

test("figures are formatted for French readers and partial periods are noticed", () => {
  assert.equal(nbsp(formatCount(1234567)), "1 234 567");
  assert.equal(formatRate(0.25), "0,3");
  assert.equal(formatRate(42.4), "42");
  assert.equal(partialPeriod({ since: "2026-11-01T00:00:00Z", recording_since: "2026-11-01T06:00:00Z" }), true);
  assert.equal(partialPeriod({ since: "2026-11-01T00:00:00Z", recording_since: "2026-10-20T00:00:00Z" }), false);
  assert.equal(partialPeriod({ since: "2026-11-01T00:00:00Z", recording_since: null }), true);
  assert.ok(CONTRIBUTION_LABELS.prices_connector && PAGE_LABELS.basket);
});

test("a page is reported by its kind, never by its address", () => {
  const cases = {
    "/": "home", "/v2": "home", "/v2/produits": "products", "/v2/produits/12": "product", "/v2/produits/12/historique": "product",
    "/v2/produits/12/modifier": "product_edit", "/v2/produits/nouveau": "product_edit", "/v2/brouillons/4": "product_edit",
    "/v2/categories/Lait%20demi": "category", "/v2/magasins": "stores", "/v2/magasins/9": "store", "/v2/recettes": "recipes",
    "/v2/recettes/3": "recipe", "/v2/recettes/nouvelle": "recipe", "/v2/panier": "basket", "/v2/parametres/serveur": "settings",
    "/v2/settings/database": "settings", "/v2/capture": "capture", "/v2/a-completer": "completion", "/v2/connexion": "auth",
    "/v2/inscription": "auth", "/v2/versions": "versions", "/v2/changelog/products": "changelog", "/v2/mentions-legales": "legal",
    "/v2/panier/": "basket", "/v2/inconnu": "other", "/v2/produits/12/jean.dupont@example.org": "other",
  };
  for (const [path, page] of Object.entries(cases)) assert.equal(pageKeyForPath(path), page, path);
});

test("the beacon sends only the page kind and whether it opened a visit, without cookies", () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return {}; };
  reportPage("/v2/produits/12?q=Jean%20Dupont");
  reportPage("/v2/panier");
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0][1].body), { page: "product", visit: true });
  assert.deepEqual(JSON.parse(calls[1][1].body), { page: "basket", visit: false }, "only the first page of a tab session is a visit");
  assert.equal(calls[0][0], "/api/v2/stats/page");
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].keepalive, true);
  assert.ok(!JSON.stringify(calls).includes("Jean"));
});

test("storage that refuses writes still lets a page be counted", () => {
  globalThis.sessionStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(init.body); return {}; };
  reportPage("/v2/panier");
  assert.deepEqual(JSON.parse(calls[0]), { page: "basket", visit: false });
});
