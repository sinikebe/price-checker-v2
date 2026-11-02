/* Pure decisions of the extension: no DOM, no network, no storage, so they can be tested on their own. */
(function (root) {
  "use strict";

  /** "Le Mesnil-le-Roi" -> "le-mesnil-le-roi": the way a retailer writes a town in an address. */
  function slug(text) {
    if (typeof text !== "string") return "";
    return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  /** Does the store the retailer's page shows ("city-maisons-laffitte") belong to this town? */
  function storeMatches(pageSlug, city) {
    var town = slug(city), page = slug(pageSlug);
    if (!town || !page) return false;
    return ("-" + page + "-").indexOf("-" + town + "-") >= 0;
  }

  /**
   * What one reading of a product means. `answer` is what the carrefour.fr content script returned.
   * "not_sold" is only said when the site answered normally, found nothing with this barcode, and the
   * store the person has chosen was already confirmed during this job: a silent failure must never
   * make a product look withdrawn.
   */
  function classify(answer, verifiedStore) {
    if (!answer || typeof answer !== "object") return { outcome: "error", detail: "no answer" };
    if (answer.challenge) return { outcome: "challenge" };
    if (!answer.ok) return { outcome: "error", detail: answer.error || "HTTP " + answer.status };
    var parsed = answer.parsed || {};
    var match = (parsed.matches || [])[0];
    if (match) {
      if (!answer.page || !answer.page.found) return { outcome: "error", detail: "the product page has no data" };
      if (typeof match.price !== "number") return { outcome: "error", detail: "no price on the page" };
      return {
        outcome: "price", price: match.price, available: match.available !== false, title: match.title || null,
        url: match.url || null, storeSlug: match.storeSlug || null, storeLabel: match.store || null
      };
    }
    var normal = answer.status === 200 && /json/i.test(answer.contentType || "") && parsed.looked > 5 && (parsed.topKeys || []).length > 0;
    if (normal && verifiedStore) return { outcome: "not_sold" };
    return { outcome: "error", detail: normal ? "not found, store not confirmed yet" : "unusual answer" };
  }

  /** A pause between two products, a little irregular, like a person reading. */
  function pause(random) {
    var r = typeof random === "number" && isFinite(random) ? random : Math.random();
    return Math.round(6000 + Math.min(Math.max(r, 0), 1) * 6000);
  }

  var ADAPTERS = ["carrefour"];
  var MAX_ITEMS = 60;

  /** The only job the extension accepts from a page, checked field by field. Anything else is refused. */
  function validJob(data) {
    if (!data || typeof data !== "object" || data.type !== "refresh") return null;
    if (typeof data.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(data.id)) return null;
    if (ADAPTERS.indexOf(data.adapter) < 0) return null;
    if (typeof data.storeHint !== "string" || !slug(data.storeHint) || data.storeHint.length > 80) return null;
    if (!Array.isArray(data.items) || !data.items.length || data.items.length > MAX_ITEMS) return null;
    var items = [];
    for (var i = 0; i < data.items.length; i++) {
      var item = data.items[i];
      if (!item || !Number.isSafeInteger(item.product_id) || item.product_id < 1 || typeof item.ean !== "string" || !/^\d{8,14}$/.test(item.ean)) return null;
      items.push({ product_id: item.product_id, ean: item.ean });
    }
    return { id: data.id, adapter: data.adapter, storeHint: data.storeHint, items: items };
  }

  var api = { slug: slug, storeMatches: storeMatches, classify: classify, pause: pause, validJob: validJob, MAX_ITEMS: MAX_ITEMS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PriceCheckerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
