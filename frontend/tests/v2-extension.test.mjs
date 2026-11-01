import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const directory = new URL("../browser-extension/", import.meta.url);
// The extension's scripts are classic scripts, not modules: run the parser in its own context, as a page would.
const sandbox = { module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(new URL("carrefour-parse.js", directory), "utf8"), sandbox);
const { sameEan, money } = sandbox.module.exports;
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
  for (const file of ["popup.html", "popup.js", "content.js", "carrefour-parse.js"]) {
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
