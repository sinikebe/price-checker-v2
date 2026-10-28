import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(join(process.cwd(), "src/v2/bookmarklet-capture.js"), "utf8")
  .replace('"__V2_CAPTURE_URL__"', '"https://price.example/v2/capture"');

function node(text, extra = {}) {
  return { textContent: text, parentElement: null, tagName: "SPAN", getAttribute: () => null,
    getClientRects: () => [1], querySelectorAll: () => [], querySelector: () => null, ...extra };
}
function run({ host, path = "/p", jsonLd = [], selectors = {}, body = "", heading = "Produit", title = "" }) {
  const root = node("", { tagName: "DIV", querySelectorAll: selector => selectors[selector] || [] });
  const h1 = node(heading, { tagName: "H1", parentElement: root });
  const document = {
    title, body: { innerText: body }, querySelector: selector => selector === "h1" ? h1 : null,
    querySelectorAll: selector => selector === 'script[type="application/ld+json"]'
      ? jsonLd.map(value => node(JSON.stringify(value))) : selectors[selector] || [],
  };
  const location = { hostname: host, pathname: path, origin: "https://" + host, href: "https://" + host + path };
  let opened = "";
  const alerts = [];
  const window = { open: target => { opened = target; return {}; }, alert: message => alerts.push(message) };
  vm.runInNewContext(source, { document, location, window, URL, Date, JSON, Number, String, Array,
    Math, RegExp, encodeURIComponent, isFinite });
  if (!opened) return { blocked: true, alerts };
  assert.match(opened, /^https:\/\/price\.example\/v2\/capture#p=/);
  return JSON.parse(decodeURIComponent(opened.slice(opened.indexOf("#p=") + 3)));
}

test("structured product yields checked EAN and price without another retailer request", () => {
  const item = run({ host: "www.intermarche.com", path: "/produit/3073781178005", heading: "Farine T45",
    jsonLd: [{ "@type": "Product", name: "Farine T45", gtin13: "3073781178005",
      offers: { "@type": "Offer", price: "2.36", priceCurrency: "EUR" } }] });
  assert.equal(item.ean, "3073781178005");
  assert.equal(item.price, 2.36);
  assert.equal(item.source, "schema.org");
  assert.equal(item.url, "https://www.intermarche.com/produit/3073781178005");
});

test("Auchan ignores hidden metadata and unrelated or per-unit prices", () => {
  const item = run({ host: "www.auchan.fr", path: "/produit/pr-C123", heading: "Mayonnaise 415 g",
    body: "Réf / EAN : 120560 / 8711200548002",
    jsonLd: [{ "@type": "Product", name: "Mayonnaise 415 g", offers: { price: "1.99", priceCurrency: "EUR" } }],
    selectors: { '.price__now': [node("4,72 €/kg")], '.product-detail__price': [node("1,99 €")] } });
  assert.equal(item.ean, "8711200548002");
  assert.equal(item.price, null);
});

test("invalid URL barcode and non-euro offer are not accepted", () => {
  const item = run({ host: "www.intermarche.com", path: "/produit/3073781178006", heading: "Farine T45",
    jsonLd: [{ "@type": "Product", name: "Farine T45", offers: { price: "3.00", priceCurrency: "USD" } }] });
  assert.equal(item.ean, null);
  assert.equal(item.price, null);
});

test("retailer verification and empty error pages cannot become product captures", () => {
  const challenge = run({ host: "www.carrefour.fr", path: "/p/farine-3068110702235",
    title: "Un instant…", heading: "C’est une formalité… si vous êtes un humain !" });
  assert.equal(challenge.blocked, true);
  assert.match(challenge.alerts[0], /Aucune fiche produit lisible/);

  const forbidden = run({ host: "www.intermarche.com", path: "/produit/farine/3068110702235",
    heading: null });
  assert.equal(forbidden.blocked, true);
  assert.match(forbidden.alerts[0], /Aucune fiche produit lisible/);
});

test("Auchan reads the main offer price, not recommendation or per-unit prices", () => {
  const item = run({ host: "www.auchan.fr", path: "/auchan-gel-lave-vaisselle/pr-C1779644",
    heading: "Gel lave-vaisselle", body: "Réf / EAN : 12345 / 3596710534050",
    selectors: {
      ".offer-selector__price-container .product-price--large": [node("5,40€")],
      ".price__now": [node("8,87€")],
      ".product-price": [node("3,60€ / l")],
    } });
  assert.equal(item.ean, "3596710534050");
  assert.equal(item.price, 5.4);
  assert.equal(item.source, "visible:auchan");
});

test("Carrefour reads one nested EUR offer but not ambiguous multiple offers", () => {
  const one = run({ host: "www.carrefour.fr", heading: "Désodorisant",
    jsonLd: [{ "@type": "Product", name: "Désodorisant", gtin13: "3059946163611",
      offers: { "@type": "AggregateOffer", priceCurrency: "EUR", offerCount: 1,
        offers: [{ "@type": "Offer", price: 5.95, priceCurrency: "EUR" }] } }] });
  assert.equal(one.price, 5.95);
  assert.equal(one.source, "schema.org");

  const many = run({ host: "www.carrefour.fr", heading: "Désodorisant",
    jsonLd: [{ "@type": "Product", name: "Désodorisant", gtin13: "3059946163611",
      offers: { "@type": "AggregateOffer", priceCurrency: "EUR", offerCount: 2,
        offers: [{ price: 5.95, priceCurrency: "EUR" }, { price: 6.15, priceCurrency: "EUR" }] } }] });
  assert.equal(many.price, null);

  const incomplete = run({ host: "www.carrefour.fr", heading: "Désodorisant",
    jsonLd: [{ "@type": "Product", name: "Désodorisant",
      offers: { "@type": "AggregateOffer", priceCurrency: "EUR", offerCount: 2,
        offers: [{ price: 5.95, priceCurrency: "EUR" }] } }] });
  assert.equal(incomplete.price, null);
});

test("Intermarché uses a product-area price only when crossed-out price agrees with product data", () => {
  const selector = '.pdpV2-primary-price_e2e [data-testid="is-right-now"]';
  const shown = node("2,58 €", { querySelector: () => node("2,58 €") });
  const base = { "@type": "Product", name: "Clafoutis aux cerises", gtin13: "3023290643488",
    price: { currency: "€", value: 2.58 }, offers: { price: 0, priceCurrency: "EUR" } };
  const item = run({ host: "www.intermarche.com", heading: "Clafoutis aux cerises",
    jsonLd: [base], selectors: { [selector]: [shown], ".product-price": [node("7,59 €/kg")] } });
  assert.equal(item.price, 2.58);
  assert.equal(item.source, "visible:intermarche");

  const mismatch = run({ host: "www.intermarche.com", heading: "Clafoutis aux cerises",
    jsonLd: [{ ...base, price: { currency: "€", value: 3.58 } }],
    selectors: { [selector]: [shown], ".product-price": [node("7,59 €/kg")] } });
  assert.equal(mismatch.price, null);
});
