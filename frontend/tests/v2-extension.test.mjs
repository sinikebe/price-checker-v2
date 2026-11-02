import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const directory = new URL("../browser-extension/", import.meta.url);
// The extension's scripts are classic scripts, not modules: run the parser in its own context, as a page would.
const sandbox = { module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(new URL("carrefour-parse.js", directory), "utf8"), sandbox);
const { sameEan, money } = sandbox.module.exports;
const productPageUrl = (url, ean) => sandbox.module.exports.productPageUrl(url, ean);
const parseProductPage = (html, ean) => JSON.parse(JSON.stringify(sandbox.module.exports.parseProductPage(html, ean)));
const parseSearch = (text, ean) => JSON.parse(JSON.stringify(sandbox.module.exports.parseSearch(text, ean)));
const EAN = "7613039830727";

test("the same EAN is recognised with or without leading zeros, and nothing else is", () => {
  assert.equal(sameEan("07613039830727", EAN), true);
  assert.equal(sameEan(7613039830727, EAN), true);
  assert.equal(sameEan("3270190008262", EAN), false);
  assert.equal(sameEan("abc", EAN), false);
  assert.equal(sameEan("", ""), false);
});

test("prices are read from numbers and from French strings, and refused when odd", () => {
  assert.equal(money(2.89), 2.89);
  assert.equal(money("2,89 €"), 2.89);
  assert.equal(money("2.5"), 2.5);
  for (const odd of [0, -1, 1e6, NaN, "gratuit", "2,891", null, true, {}]) assert.equal(money(odd), null, String(odd));
});

test("a product with the EAN is found in a nested answer, with every price and where it was", () => {
  const answer = { data: { products: [
    { ean: "3270190008262", title: "Huile", price: 9.49 },
    { ean: EAN, title: "Fond de Veau MAGGI", brand: "MAGGI", slug: "fond-de-veau-maggi-7613039830727", facilityServiceId: "0261-150-6",
      price: { price: 2.89, unit_price: 26.27, per_unit_label: "26.27 € / KG" }, regular_price: 2.89 },
  ] } };
  const found = parseSearch(JSON.stringify(answer), EAN);
  assert.equal(found.found, true);
  const [match] = found.matches;
  assert.equal(match.title, "Fond de Veau MAGGI");
  assert.equal(match.url, "https://www.carrefour.fr/p/fond-de-veau-maggi-7613039830727");
  assert.equal(match.price, 2.89);
  assert.deepEqual(match.prices.map(price => price.value), [2.89, 2.89]);
  assert.ok(!match.prices.some(price => /unit/i.test(price.path)), "the price per kilo is never offered as the price");
  assert.deepEqual(match.hints, { facilityServiceId: "0261-150-6" });
});

test("another product is never taken for the one asked: no EAN match means not found", () => {
  const answer = { products: [{ ean: "3284230004282", title: "Pain au chocolat", price: 3.39 }] };
  const found = parseSearch(JSON.stringify(answer), EAN);
  assert.equal(found.found, false);
  assert.deepEqual(found.topKeys, ["products"]);
});

test("a promotion price is never mistaken for the shelf price", () => {
  const found = parseSearch(JSON.stringify([{ gtin: EAN, name: "X", price: 3.5, promoPrice: 2.9 }]), EAN);
  assert.deepEqual(found.matches[0].prices.map(price => price.value), [3.5]);
});

test("the answer can also be a page with embedded JSON, and garbage is simply not found", () => {
  const page = `<html><script type="application/ld+json">{"@type":"Product","gtin13":"${EAN}","name":"Fond","offers":{"price":"2.89"}}</script></html>`;
  const found = parseSearch(page, EAN);
  assert.equal(found.found, true);
  assert.equal(found.matches[0].price, 2.89);
  for (const text of ["", "<html>no data</html>", "not json {", "null", "123"]) assert.equal(parseSearch(text, EAN).found, false, text);
});

test("a huge or deeply nested answer stops instead of hanging", () => {
  let deep = { ean: EAN, price: 1 };
  for (let i = 0; i < 100; i++) deep = { child: deep };
  assert.equal(parseSearch(JSON.stringify(deep), EAN).found, false, "beyond the depth bound");
  const wide = { list: Array.from({ length: 100000 }, (_, i) => ({ id: i })) };
  const started = Date.now();
  parseSearch(JSON.stringify(wide), EAN);
  assert.ok(Date.now() - started < 3000);
});

test("the extension asks for no more than it needs and loads nothing from outside", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.carrefour.fr/*"]);
  assert.deepEqual(manifest.content_scripts.map(script => script.matches), [["https://www.carrefour.fr/*"]]);
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>") && !JSON.stringify(manifest).includes("http://*/"));
  for (const file of ["popup.html", "popup.js", "content.js", "carrefour-parse.js", "extension-core.js", "app-bridge.js", "background.js"]) {
    const text = readFileSync(new URL(file, directory), "utf8");
    assert.ok(!/eval\(|new Function|innerHTML|document\.write|https?:\/\/(?!www\.carrefour\.fr)[a-z0-9.-]+\.[a-z]{2,}\/[^"'\s]*\.js/.test(text), file);
  }
  const popup = readFileSync(new URL("popup.html", directory), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(popup), "no inline script");
});

test("the zip handed out by the settings page is a valid archive with every extension file", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readdirSync, writeFileSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const ts = (await import("typescript")).default;
  const compile = name => ts.transpileModule(read(new URL(`../src/v2/${name}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { makeZip, crc32 } = await import("data:text/javascript;base64," + Buffer.from(compile("v2-zip.ts")).toString("base64"));
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "the standard CRC-32 check value");
  // The files the page bundles are exactly the extension's own files.
  const listing = read(new URL("../src/v2/v2-extension-files.ts", import.meta.url), "utf8");
  const onDisk = readdirSync(new URL(directory)).sort();
  for (const file of onDisk) assert.ok(listing.includes(`browser-extension/${file}?raw`), `${file} is bundled`);
  assert.equal([...listing.matchAll(/browser-extension\/([\w.-]+)\?raw/g)].length, onDisk.length, "nothing else is bundled");
  const encoder = new TextEncoder();
  const files = [...onDisk, "instance.json"].map(name => ({ name, data: name === "instance.json" ? encoder.encode('{"instance":"https://price.example"}\n') : read(new URL(name, directory)) }));
  const folder = mkdtempSync(tmpdir() + "/pc-zip-");
  writeFileSync(folder + "/x.zip", makeZip(files, new Date(2026, 10, 1, 12, 30, 40)));
  const check = spawnSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(sorted(z.namelist()));print(z.read('instance.json').decode().strip());print(z.read('manifest.json')==open(sys.argv[2],'rb').read())", folder + "/x.zip", new URL("manifest.json", directory).pathname], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /instance\.json/);
  assert.match(check.stdout, /\{"instance":"https:\/\/price\.example"\}/);
  assert.match(check.stdout, /True/);
  assert.throws(() => makeZip([{ name: "../evil.js", data: new Uint8Array() }]), /invalide/);
  assert.throws(() => makeZip([{ name: "/abs.js", data: new Uint8Array() }]), /invalide/);
});


// The shape of a real product page: a schema.org Product with an AggregateOffer, and the chosen store in the page data.
const PAGE = ean => `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"Pâtes spaghetti CARREFOUR","url":"https://www.carrefour.fr/p/pates-spaghetti-carrefour-${ean}","gtin13":"${ean}","brand":{"@type":"Brand","name":"CARREFOUR"},
"offers":{"@type":"AggregateOffer","offerCount":1,"lowPrice":1.35,"highPrice":1.35,"priceCurrency":"EUR","offers":[{"@type":"Offer","price":1.35,"priceCurrency":"EUR","availability":"https://schema.org/InStock","seller":{"@type":"Organization","name":"Carrefour Drive"}}]}}</script>
</head><body><script>window.x={"storeUrl":"/magasin/city-maisons-laffitte","storePageUrl":"/magasin/city-maisons-laffitte"}</script></body></html>`;

test("a product page gives the price once, the seller, the availability and the store the page shows", () => {
  const page = parseProductPage(PAGE("3560070328888"), "3560070328888");
  assert.equal(page.found, true);
  assert.deepEqual(page.prices.map(price => price.value), [1.35], "the lowest, highest and offer price are the same offer, listed once");
  assert.equal(page.price, 1.35);
  assert.equal(page.seller, "Carrefour Drive");
  assert.equal(page.available, true);
  assert.equal(page.storeSlug, "city-maisons-laffitte");
  assert.equal(page.storeLabel, "city maisons laffitte");
  assert.equal(page.url, "https://www.carrefour.fr/p/pates-spaghetti-carrefour-3560070328888");
  assert.equal(page.brand, "CARREFOUR");
});

test("a page for another product, or without data, never gives a price", () => {
  assert.equal(parseProductPage(PAGE("3560070328888"), "7613039830727").found, false);
  assert.equal(parseProductPage(PAGE("3560070328888"), "7613039830727").price, null);
  for (const html of ["", "<html></html>", "<script type=\"application/ld+json\">{bad</script>"]) assert.equal(parseProductPage(html, "3560070328888").found, false);
  assert.equal(parseProductPage(null, "3560070328888").found, false);
  const soldOut = PAGE("3560070328888").replace("InStock", "OutOfStock");
  assert.equal(parseProductPage(soldOut, "3560070328888").available, false);
});

test("the page address is the search's slug plus the EAN, and nothing else is built", () => {
  assert.equal(productPageUrl("https://www.carrefour.fr/p/pates-spaghetti-carrefour", "3560070328888"), "https://www.carrefour.fr/p/pates-spaghetti-carrefour-3560070328888");
  assert.equal(productPageUrl("https://www.carrefour.fr/p/pates-spaghetti-carrefour-3560070328888", "3560070328888"), "https://www.carrefour.fr/p/pates-spaghetti-carrefour-3560070328888");
  for (const url of ["https://evil.example/p/x", "http://www.carrefour.fr/p/x", "https://www.carrefour.fr/p/x?next=https://evil.example", "https://www.carrefour.fr/p/../admin", null, 5])
    assert.equal(productPageUrl(url, "3560070328888"), null, String(url));
  assert.equal(productPageUrl("https://www.carrefour.fr/p/x", "abc"), null);
});

// --- the extension's decisions, run as a page would run them
const coreBox = { module: { exports: {} } };
coreBox.globalThis = coreBox;
vm.runInNewContext(readFileSync(new URL("extension-core.js", directory), "utf8"), coreBox);
const core = coreBox.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));

test("a town is compared with the store the retailer's page shows, whatever the spelling", () => {
  assert.equal(core.slug("Le Mesnil-le-Roi"), "le-mesnil-le-roi");
  assert.equal(core.slug("  Épône  "), "epone");
  assert.equal(core.storeMatches("city-maisons-laffitte", "Maisons-Laffitte"), true);
  assert.equal(core.storeMatches("carrefour-maisons-laffitte-centre", "Maisons Laffitte"), true);
  assert.equal(core.storeMatches("city-sartrouville", "Maisons-Laffitte"), false);
  assert.equal(core.storeMatches("city-maisons-laffittes", "Maisons-Laffitte"), false, "whole words only");
  for (const [slug, city] of [["", "x"], ["x", ""], [null, "x"], ["x", null]]) assert.equal(core.storeMatches(slug, city), false);
});

const FOUND = { ok: true, status: 200, contentType: "application/json", challenge: false, parsed: { looked: 40, topKeys: ["data"], matches: [{ title: "Pâtes", url: "https://www.carrefour.fr/p/x-1", price: 1.35, store: "city maisons laffitte", storeSlug: "city-maisons-laffitte", available: true }] }, page: { found: true } };

test("one reading becomes a price, a withdrawal, an error or a wait for the person", () => {
  assert.deepEqual(plain(core.classify(FOUND, false)), { outcome: "price", price: 1.35, available: true, title: "Pâtes", url: "https://www.carrefour.fr/p/x-1", storeSlug: "city-maisons-laffitte", storeLabel: "city maisons laffitte" });
  assert.equal(core.classify({ ...FOUND, challenge: true }, true).outcome, "challenge");
  assert.equal(core.classify({ ok: false, status: 500 }, true).outcome, "error");
  assert.equal(core.classify({ ...FOUND, page: { found: false } }, true).outcome, "error", "no page data: no price");
  assert.equal(core.classify({ ...FOUND, parsed: { ...FOUND.parsed, matches: [{ ...FOUND.parsed.matches[0], price: null }] } }, true).outcome, "error");
  assert.equal(core.classify(null, true).outcome, "error");
});

test("a product is only called not sold on a normal answer and once the store has been confirmed", () => {
  const empty = { ok: true, status: 200, contentType: "application/json; charset=utf-8", challenge: false, parsed: { looked: 40, topKeys: ["data", "links", "meta"], matches: [] } };
  assert.equal(core.classify(empty, true).outcome, "not_sold");
  assert.equal(core.classify(empty, false).outcome, "error", "store not confirmed yet: never a withdrawal");
  assert.equal(core.classify({ ...empty, contentType: "text/html" }, true).outcome, "error");
  assert.equal(core.classify({ ...empty, parsed: { looked: 1, topKeys: [], matches: [] } }, true).outcome, "error", "an empty or odd answer is not proof");
  assert.equal(core.classify({ ...empty, status: 200, challenge: true }, true).outcome, "challenge");
});

test("the pause between two products stays within a few seconds, like a person", () => {
  assert.equal(core.pause(0), 6000);
  assert.equal(core.pause(1), 12000);
  for (const r of [-5, 2, NaN]) assert.ok(core.pause(r) >= 6000 && core.pause(r) <= 12000);
});

test("only a well formed job from the page is accepted", () => {
  const job = { type: "refresh", id: "job-abc123", adapter: "carrefour", storeHint: "Maisons-Laffitte", items: [{ product_id: 7, ean: "3560070328888" }] };
  assert.deepEqual(plain(core.validJob({ ...job, extra: "<script>" })), { id: "job-abc123", adapter: "carrefour", storeHint: "Maisons-Laffitte", items: [{ product_id: 7, ean: "3560070328888" }] });
  const bad = [null, {}, { ...job, type: "other" }, { ...job, id: "a b" }, { ...job, id: "x".repeat(65) }, { ...job, adapter: "leclerc" }, { ...job, storeHint: "" },
    { ...job, storeHint: "x".repeat(81) }, { ...job, items: [] }, { ...job, items: Array.from({ length: 61 }, () => job.items[0]) },
    { ...job, items: [{ product_id: 0, ean: "3560070328888" }] }, { ...job, items: [{ product_id: 1.5, ean: "3560070328888" }] },
    { ...job, items: [{ product_id: 1, ean: "abc" }] }, { ...job, items: [{ product_id: 1, ean: "35600703288881234" }] }, { ...job, items: ["x"] }];
  for (const value of bad) assert.equal(core.validJob(value), null, JSON.stringify(value).slice(0, 60));
});

// --- the page's side of the bridge
const compile = name => ts.transpileModule(readFileSync(new URL(`../src/v2/${name}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const bridge = await import("data:text/javascript;base64," + Buffer.from(compile("v2-extension-bridge.ts")).toString("base64"));
const manifestModule = await import("data:text/javascript;base64," + Buffer.from(compile("v2-extension-manifest.ts")).toString("base64"));
const PLAN = { store: { id: 45, name: "Carrefour City Maisons-Laffitte", city: "Maisons-Laffitte", postal_code: "78600", retailer: "Carrefour" }, reason: null,
  items: [{ product_id: 7, ean: "3560070328888", brand: "Carrefour", name: "Pâtes" }, { product_id: 8, ean: "7613039830727", brand: "Maggi", name: "Fond" }] };

test("the job handed to the extension carries only products and a town, never a credential", () => {
  const message = bridge.jobMessage("job-1", PLAN);
  assert.deepEqual(message, { source: "pc-app", type: "refresh", id: "job-1", adapter: "carrefour", storeHint: "Maisons-Laffitte",
    items: [{ product_id: 7, ean: "3560070328888" }, { product_id: 8, ean: "7613039830727" }] });
  assert.equal(bridge.jobMessage("job-1", { ...PLAN, store: null }), null);
  assert.equal(bridge.jobMessage("job-1", { ...PLAN, items: [] }), null);
  assert.equal(bridge.jobMessage("job-1", { ...PLAN, store: { ...PLAN.store, city: null } }), null);
});

test("what is recorded for a reading: a price rounded to the cent, a withdrawal, or nothing", () => {
  const price = { product_id: 7, ean: "3560070328888", outcome: "price", price: 1.349, available: true, url: "https://www.carrefour.fr/p/x-3560070328888", title: "Pâtes" };
  assert.deepEqual(bridge.readingBody(PLAN, price), { adapter: "carrefour", store_id: 45, product_id: 7, ean: "3560070328888", outcome: "price", price: 1.35, available: true,
    source_url: "https://www.carrefour.fr/p/x-3560070328888", title: "Pâtes" });
  assert.equal(bridge.readingBody(PLAN, { ...price, url: "https://evil.example/p" }).source_url, null, "an address from elsewhere is dropped");
  assert.equal(bridge.readingBody(PLAN, { ...price, available: false }).available, false);
  assert.deepEqual(bridge.readingBody(PLAN, { product_id: 8, ean: "7613039830727", outcome: "not_sold" }), { adapter: "carrefour", store_id: 45, product_id: 8, ean: "7613039830727", outcome: "not_sold" });
  for (const odd of [{ ...price, outcome: "error" }, { ...price, outcome: "challenge" }, { ...price, price: 0 }, { ...price, price: -2 }, { ...price, price: 10000 }, { ...price, price: "1" }, { ...price, ean: "abc" }, { ...price, product_id: 1.5 }])
    assert.equal(bridge.readingBody(PLAN, odd), null, JSON.stringify(odd).slice(0, 50));
  assert.equal(bridge.readingBody({ ...PLAN, store: null }, price), null);
});

test("a message from the extension is accepted only for this job and only when well formed", () => {
  const ok = { source: "pc-ext", id: "job-1" };
  assert.deepEqual(bridge.parseEvent({ ...ok, type: "started", total: 2 }, "job-1"), { type: "started", total: 2 });
  assert.deepEqual(bridge.parseEvent({ ...ok, type: "progress", done: 1, total: 2, item: { product_id: 7, ean: "3560070328888", outcome: "price", price: 1.35 } }, "job-1"),
    { type: "progress", done: 1, total: 2, item: { product_id: 7, ean: "3560070328888", outcome: "price", price: 1.35 } });
  assert.deepEqual(bridge.parseEvent({ ...ok, type: "aborted", reason: "wrong_store", store: "city sartrouville" }, "job-1"), { type: "aborted", reason: "wrong_store", store: "city sartrouville" });
  assert.deepEqual(bridge.parseEvent({ ...ok, type: "done" }, "job-1"), { type: "done" });
  for (const bad of [null, "x", { ...ok, id: "other", type: "done" }, { source: "pc-app", id: "job-1", type: "done" }, { ...ok, type: "progress", done: 1, total: 2, item: { product_id: 7, ean: "1", outcome: "weird" } },
    { ...ok, type: "progress", done: "1", total: 2, item: { product_id: 7, ean: "1", outcome: "price" } }, { ...ok, type: "started", total: "2" }, { ...ok, type: "unknown" }, { ...ok }])
    assert.equal(bridge.parseEvent(bad, "job-1"), null, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(bridge.parseEvent({ ...ok, type: "aborted", reason: "x".repeat(100) }, "job-1").reason.length, 40);
});

test("the stop reasons are told in words, with the store the page showed", () => {
  assert.match(bridge.abortText("wrong_store", PLAN, "city sartrouville"), /city sartrouville.*Carrefour City Maisons-Laffitte \(Maisons-Laffitte\)/);
  assert.match(bridge.abortText("errors", PLAN), /Trois lectures/);
  assert.match(bridge.abortText("anything", PLAN), /interrompu/);
});

test("the copy handed out by an instance also reads that instance's pages, and nothing else is added", () => {
  const base = readFileSync(new URL("manifest.json", directory), "utf8");
  const copy = JSON.parse(manifestModule.instanceManifest(base, "https://192.168.1.244"));
  assert.deepEqual(copy.host_permissions, ["https://www.carrefour.fr/*", "https://192.168.1.244/*"]);
  assert.deepEqual(copy.content_scripts.at(-1), { matches: ["https://192.168.1.244/*"], js: ["extension-core.js", "app-bridge.js"], run_at: "document_start" });
  assert.deepEqual(copy.content_scripts[0], JSON.parse(base).content_scripts[0], "the Carrefour script is untouched");
  assert.equal(copy.background.service_worker, "background.js");
  for (const bad of ["http://price.example", "https://price.example/path", "https://price.example/", "ftp://x", "javascript:alert(1)", "", "price.example", "https://*.example"])
    assert.throws(() => manifestModule.instanceManifest(base, bad), /invalide/, bad);
  assert.doesNotThrow(() => manifestModule.instanceManifest(base, "http://localhost:8080"));
  assert.equal(manifestModule.validInstance("https://price-checker.ddns.net"), true);
});

// --- the background worker, run against a fake browser
function worker(answers, existingTab = true) {
  const out = [], calls = { sent: [], focused: 0, created: 0, removed: 0 };
  let onConnect, onMessage;
  const tab = { id: 9, windowId: 3, status: "complete" };
  let opened = existingTab;
  const box = {
    console, Date, Math, JSON, Promise, Number, isFinite, parseInt, parseFloat, String, Array, Object, RegExp, Error,
    setTimeout: fn => { setImmediate(fn); return 0; },
    chrome: {
      runtime: { id: "ext-id", onConnect: { addListener: fn => { onConnect = fn; } } },
      tabs: {
        query: async () => opened ? [tab] : [], get: async () => tab,
        create: async () => { calls.created += 1; opened = true; return tab; }, remove: async () => { calls.removed += 1; },
        update: async () => { calls.focused += 1; },
        sendMessage: async (_id, message) => { calls.sent.push(message.ean); const next = answers.shift(); if (next instanceof Error) throw next; return next; },
      },
      windows: { update: async () => undefined },
    },
  };
  box.self = box; box.globalThis = box;
  box.importScripts = (...files) => { for (const file of files) vm.runInContext(readFileSync(new URL(file, directory), "utf8"), box); };
  vm.createContext(box);
  vm.runInContext(readFileSync(new URL("background.js", directory), "utf8"), box);
  const port = { name: "app-bridge", sender: { id: "ext-id" }, postMessage: message => out.push(JSON.parse(JSON.stringify(message))),
    onMessage: { addListener: fn => { onMessage = fn; } }, onDisconnect: { addListener: () => undefined }, disconnect() { out.push({ type: "disconnected" }); } };
  onConnect(port);
  const finished = async () => { for (let i = 0; i < 20000 && !out.some(m => m.type === "done" || m.type === "aborted"); i++) await new Promise(resolve => setImmediate(resolve)); };
  return { out, calls, send: message => onMessage(message), finished, tab, connect: p => onConnect(p) };
}
const JOB = { type: "refresh", id: "job-1", adapter: "carrefour", storeHint: "Maisons-Laffitte", items: [3, 4, 5].map(n => ({ product_id: n, ean: "35600703288" + (80 + n) })) };
const priced = (price, slug = "city-maisons-laffitte") => ({ ...FOUND, parsed: { ...FOUND.parsed, matches: [{ ...FOUND.parsed.matches[0], price, storeSlug: slug }] } });
const EMPTY = { ok: true, status: 200, contentType: "application/json", challenge: false, parsed: { looked: 40, topKeys: ["data"], matches: [] } };

test("a job reads each product in the person's own Carrefour tab and reports each result", async () => {
  const w = worker([priced(1.35), EMPTY, priced(2.1)]);
  w.send(JOB); await w.finished();
  assert.deepEqual(w.out.map(m => m.type), ["started", "progress", "progress", "progress", "done"]);
  assert.deepEqual(w.out.filter(m => m.type === "progress").map(m => [m.done, m.item.product_id, m.item.outcome, m.item.price ?? null]), [[1, 3, "price", 1.35], [2, 4, "not_sold", null], [3, 5, "price", 2.1]]);
  assert.deepEqual(w.calls.sent, ["3560070328883", "3560070328884", "3560070328885"]);
  assert.equal(w.calls.created, 0, "the person's open tab is reused");
  assert.ok(w.out.every(m => m.id === "job-1"));
});

test("a product is not called withdrawn before the chosen store has been confirmed by a price", async () => {
  const w = worker([EMPTY, priced(1.35), EMPTY]);
  w.send(JOB); await w.finished();
  assert.deepEqual(w.out.filter(m => m.type === "progress").map(m => m.item.outcome), ["error", "price", "not_sold"]);
});

test("the job stops when the store on the site is not the application's store, and records nothing more", async () => {
  const w = worker([priced(1.35, "city-sartrouville"), priced(2)]);
  w.send(JOB); await w.finished();
  assert.deepEqual(w.out.map(m => m.type), ["started", "aborted"]);
  assert.deepEqual([w.out[1].reason, w.out[1].store], ["wrong_store", "city maisons laffitte"]);
  assert.equal(w.calls.sent.length, 1);
});

test("three readings in a row that fail stop the job", async () => {
  const w = worker([{ ok: false, status: 500 }, { ok: false, status: 502 }, { ok: false, status: 503 }, priced(1)]);
  w.send(JOB); await w.finished();
  assert.equal(w.out.at(-1).reason, "errors");
  assert.equal(w.out.filter(m => m.type === "progress").length, 3);
});

test("a check by the site brings its tab forward and the job carries on by itself afterwards", async () => {
  const challenge = { ok: false, status: 403, challenge: true };
  const w = worker([challenge, challenge, priced(1.35), priced(2), priced(3)]);
  w.send(JOB); await w.finished();
  assert.deepEqual(w.out.map(m => m.type), ["started", "needs-human", "resumed", "progress", "progress", "progress", "done"]);
  assert.equal(w.calls.focused, 1, "the tab is brought forward once, not on every wait");
  assert.equal(w.out.filter(m => m.type === "progress")[0].item.price, 1.35);
});

test("a job that is not valid, or arrives while another runs, is refused, and a stranger's port is closed", async () => {
  const w = worker([priced(1), priced(2), priced(3)]);
  w.send({ ...JOB, adapter: "leclerc" });
  assert.deepEqual(w.out.map(m => m.reason), ["invalid_job"]);
  const stranger = [];
  w.connect({ name: "app-bridge", sender: { id: "someone-else" }, postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect: () => stranger.push("closed") });
  w.connect({ name: "other", sender: { id: "ext-id" }, postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect: () => stranger.push("closed") });
  assert.deepEqual(stranger, ["closed", "closed"]);
  w.send(JOB); w.send({ ...JOB, id: "job-2" });
  await w.finished();
  assert.ok(w.out.some(m => m.id === "job-2" && m.reason === "busy"));
});

test("a job can be cancelled and no tab the person had open is closed", async () => {
  const w = worker([priced(1.35), priced(2), priced(3)]);
  w.send(JOB);
  for (let i = 0; i < 2000 && !w.out.some(m => m.type === "progress"); i++) await new Promise(resolve => setImmediate(resolve));
  w.send({ type: "cancel" });
  await w.finished();
  assert.equal(w.out.at(-1).reason, "cancelled");
  assert.equal(w.calls.removed, 0);
});

test("a tab opened for the job is closed when it ends", async () => {
  const w = worker([priced(1), priced(2), priced(3)], false);
  w.send(JOB); await w.finished();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([w.calls.created, w.calls.removed], [1, 1]);
});


test("an unclear store is told in words that point to the basket's default stores", () => {
  assert.match(bridge.planProblem("store_ambiguous"), /plusieurs magasins Carrefour.*magasins par défaut/);
  assert.match(bridge.planProblem("store_unknown"), /aucun magasin Carrefour.*magasins par défaut/);
  assert.match(bridge.planProblem(null), /aucun magasin Carrefour/);
});
