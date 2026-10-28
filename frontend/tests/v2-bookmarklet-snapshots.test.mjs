import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const root = process.cwd();
const script = readFileSync(join(root, "src/v2/bookmarklet-capture.js"), "utf8")
  .replace('"__V2_CAPTURE_URL__"', '"https://price.example/v2/capture"');
const fixtures = [
  ["auchan.html", "www.auchan.fr", "/auchan-gel-lave-vaisselle/pr-C1779644", "3596710534050", 5.40, "visible:auchan"],
  ["carrefour.html", "www.carrefour.fr", "/p/desodorisant-lave-vaisselle-nettoyant-machine-finish-3059946163611", "3059946163611", 5.95, "schema.org"],
  ["intermarche-priced.html", "www.intermarche.com", "/produit/clafoutis-aux-cerises/3023290643488", "3023290643488", 2.58, "visible:intermarche"],
  ["coursesu.html", "www.coursesu.com", "/p/filet-de-poulet-blanc-prix-mini-france-barquette-1kg/5046393.html", "3660992018536", 10.29, "visible:coursesu"],
  ["intermarche-unavailable.html", "www.intermarche.com", "/produit/fromage-au-lait-pasteurise/3073781178005", "3073781178005", null, null],
];

for (const [filename, host, path, ean, expectedPrice, expectedSource] of fixtures) {
  test(`bookmarklet extracts the supplied ${filename} capture`, () => {
    const html = readFileSync(join(root, "tests/fixtures/bookmarklet", filename), "utf8");
    const { document } = parseHTML(html);
    // linkedom has no layout engine; the fixtures contain only visible product fragments.
    Object.defineProperty(document.body, "innerText", { value: document.body.textContent });
    const location = { hostname: host, pathname: path, origin: "https://" + host,
      href: "https://" + host + path };
    let opened = "";
    const window = { open: target => { opened = target; return {}; }, alert: () => assert.fail("Unexpected capture rejection") };
    vm.runInNewContext(script, { document, location, window, URL, Date, JSON, Number, String,
      Array, Math, RegExp, encodeURIComponent, isFinite });
    assert.match(opened, /^https:\/\/price\.example\/v2\/capture#p=/);
    const result = JSON.parse(decodeURIComponent(opened.slice(opened.indexOf("#p=") + 3)));
    assert.equal(result.ean, ean);
    assert.equal(result.price, expectedPrice);
    assert.equal(result.source, expectedSource);
    assert.equal(result.url, location.href);
  });
}
