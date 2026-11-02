/* Reads a Carrefour search answer for one EAN. Pure functions: no DOM, no network, no storage.
 *
 * The shape of the answer is not documented and can change, so nothing here is trusted blindly: the
 * result carries every price it found and where, and the popup shows them for the person to judge. */
(function (root) {
  "use strict";
  var MAX_NODES = 60000;
  var MAX_DEPTH = 14;
  var EAN_KEY = /^(ean|ean13|gtin|gtin13|barcode|codebarre)$/i;
  var PRICE_KEY = /price|prix|amount/i;
  var NOT_THE_PRICE = /unit|per|kg|litre|liter|old|before|was|ref|barr|strike|original|crossed|promo|discount|saving|remise|currency|label|text|display|format|message/i;
  var TITLE_KEYS = ["title", "name", "label", "designation", "libelle"];
  var STORE_HINT = /facility|store|drive|magasin|pdv|point.?of.?sale|shop/i;

  function digits(value) {
    if (typeof value === "number" && Number.isFinite(value)) value = String(value);
    return typeof value === "string" && /^\d{8,14}$/.test(value.trim()) ? value.trim() : null;
  }
  function sameEan(left, right) {
    var a = digits(left), b = digits(right);
    return !!a && !!b && a.replace(/^0+/, "") === b.replace(/^0+/, "");
  }
  function money(value) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 && value < 10000 ? Math.round(value * 100) / 100 : null;
    if (typeof value !== "string") return null;
    var match = value.replace(/[  \s]/g, "").match(/^(\d{1,4})(?:[.,](\d{1,2}))?€?$/);
    if (!match) return null;
    var amount = Number(match[1] + "." + (match[2] || "0"));
    return amount > 0 ? amount : null;
  }
  function firstString(object, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = object[keys[i]];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
    }
    return null;
  }
  function jsonFrom(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    try { return JSON.parse(text); } catch (error) { /* not plain JSON: look for JSON inside a page */ }
    var found = [];
    var pattern = /<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>|<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/gi;
    var match;
    while ((match = pattern.exec(text)) && found.length < 20) {
      try { found.push(JSON.parse(match[1] || match[2])); } catch (error) { /* skip */ }
    }
    return found.length ? found : null;
  }
  function pricesOf(object, path, out, depth) {
    if (depth > 4 || !object || typeof object !== "object") return;
    Object.keys(object).forEach(function (key) {
      var value = object[key];
      var here = path ? path + "." + key : key;
      if (value && typeof value === "object") { pricesOf(value, here, out, depth + 1); return; }
      if (PRICE_KEY.test(key) && !NOT_THE_PRICE.test(key)) {
        var amount = money(value);
        if (amount !== null) out.push({ path: here, value: amount });
      }
    });
  }
  function hints(object) {
    var out = {};
    Object.keys(object).forEach(function (key) {
      var value = object[key];
      if (STORE_HINT.test(key) && (typeof value === "string" || typeof value === "number") && String(value).length <= 80) out[key] = value;
    });
    return out;
  }
  function productUrl(object) {
    var value = firstString(object, ["url", "canonical_url", "link", "href", "slug"]);
    if (!value) return null;
    if (/^https:\/\/www\.carrefour\.fr\//.test(value)) return value;
    if (/^\/p\//.test(value)) return "https://www.carrefour.fr" + value;
    if (/^[a-z0-9-]+$/.test(value)) return "https://www.carrefour.fr/p/" + value;
    return null;
  }

  /** @returns {{found:boolean, matches:Array, topKeys:string[], looked:number}} */
  function parseSearch(text, ean) {
    var root_ = jsonFrom(text);
    var result = { found: false, matches: [], topKeys: [], looked: 0 };
    if (root_ === null) return result;
    result.topKeys = (root_ && typeof root_ === "object" && !Array.isArray(root_)) ? Object.keys(root_).slice(0, 25) : [];
    var seen = 0;
    var stack = [{ node: root_, depth: 0 }];
    while (stack.length && seen < MAX_NODES) {
      var item = stack.pop();
      var node = item.node;
      if (!node || typeof node !== "object") continue;
      seen += 1;
      if (!Array.isArray(node)) {
        var isMatch = Object.keys(node).some(function (key) { return EAN_KEY.test(key) && sameEan(node[key], ean); });
        if (isMatch) {
          var prices = [];
          pricesOf(node, "", prices, 0);
          result.matches.push({
            ean: String(ean), title: firstString(node, TITLE_KEYS), brand: typeof node.brand === "string" ? node.brand.slice(0, 120) : null,
            url: productUrl(node), prices: prices.slice(0, 8), price: prices.length ? prices[0].value : null, hints: hints(node)
          });
          if (result.matches.length >= 5) break;
          continue;
        }
      }
      if (item.depth >= MAX_DEPTH) continue;
      var children = Array.isArray(node) ? node : Object.keys(node).map(function (key) { return node[key]; });
      for (var i = 0; i < children.length && i < 500; i++) {
        if (children[i] && typeof children[i] === "object") stack.push({ node: children[i], depth: item.depth + 1 });
      }
    }
    result.looked = seen;
    result.found = result.matches.length > 0;
    return result;
  }

  /** The address of a product page: /p/<slug>-<ean>. The search gives the slug without the EAN. */
  function productPageUrl(url, ean) {
    if (typeof url !== "string" || !digits(ean)) return null;
    var match = url.match(/^https:\/\/www\.carrefour\.fr(\/p\/[a-z0-9-]+)$/);
    if (!match) return null;
    var tail = match[1].match(/-(\d{8,14})$/);
    return "https://www.carrefour.fr" + (tail && sameEan(tail[1], ean) ? match[1] : match[1] + "-" + digits(ean));
  }

  function productNodes(value, out, depth) {
    if (!value || typeof value !== "object" || depth > 6 || out.length > 20) return;
    if (Array.isArray(value)) { value.forEach(function (item) { productNodes(item, out, depth + 1); }); return; }
    if (value["@type"] === "Product" || (Array.isArray(value["@type"]) && value["@type"].indexOf("Product") >= 0)) out.push(value);
    if (value["@graph"]) productNodes(value["@graph"], out, depth + 1);
  }
  function offerList(offers) {
    if (!offers) return [];
    var list = Array.isArray(offers) ? offers : [offers];
    var out = [];
    list.forEach(function (offer) {
      if (!offer || typeof offer !== "object") return;
      out.push(offer);
      if (Array.isArray(offer.offers)) offer.offers.forEach(function (inner) { if (inner && typeof inner === "object") out.push(inner); });
    });
    return out;
  }

  /** The Product data of a product page (schema.org JSON-LD), and the store the page says it is showing. */
  function parseProductPage(html, ean) {
    var result = { found: false, title: null, brand: null, url: null, prices: [], price: null, available: null, seller: null, storeSlug: null, storeLabel: null };
    if (typeof html !== "string") return result;
    var storeMatch = html.match(/"(?:storeUrl|storePageUrl)"\s*:\s*"\/magasin\/([a-z0-9-]{1,80})"/);
    if (storeMatch) { result.storeSlug = storeMatch[1]; result.storeLabel = storeMatch[1].replace(/-/g, " "); }
    var blocks = [];
    var pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    var match;
    while ((match = pattern.exec(html)) && blocks.length < 20) { try { blocks.push(JSON.parse(match[1])); } catch (error) { /* skip */ } }
    var products = [];
    productNodes(blocks, products, 0);
    for (var i = 0; i < products.length; i++) {
      var product = products[i];
      var gtin = product.gtin13 || product.gtin || product.gtin14 || product.gtin8 || product.sku;
      if (!sameEan(gtin, ean)) continue;
      result.found = true;
      result.title = typeof product.name === "string" ? product.name.slice(0, 300) : null;
      result.brand = product.brand && typeof product.brand.name === "string" ? product.brand.name.slice(0, 120) : null;
      result.url = typeof product.url === "string" && /^https:\/\/www\.carrefour\.fr\//.test(product.url) ? product.url : null;
      offerList(product.offers).forEach(function (offer, index) {
        var amount = money(offer.price);
        if (amount !== null) result.prices.push({ path: "JSON-LD de la page", value: amount });
        if (result.available === null && typeof offer.availability === "string") result.available = !/OutOfStock|SoldOut|Discontinued/i.test(offer.availability);
        if (!result.seller && offer.seller && typeof offer.seller.name === "string") result.seller = offer.seller.name.slice(0, 100);
      });
      var seen = {};
      result.prices = result.prices.filter(function (price) { if (seen[price.value]) return false; seen[price.value] = true; return true; });
      result.price = result.prices.length ? result.prices[0].value : null;
      break;
    }
    return result;
  }

  var api = { parseSearch: parseSearch, parseProductPage: parseProductPage, productPageUrl: productPageUrl, sameEan: sameEan, money: money };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PriceCheckerCarrefour = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
