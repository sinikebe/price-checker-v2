(function () {
  "use strict";
  // Replaced with this V2 instance's origin when the user installs the bookmarklet.
  var destination = "__V2_CAPTURE_URL__";
  var host = location.hostname.toLowerCase();
  var heading = document.querySelector("h1");
  var headingText = clean(heading && heading.textContent, 180);
  var perUnit = /€\s*\/\s*(?:kg|g|l|cl|ml|pi[eè]ce|unit[ée])|(?:prix|tarif)\s+(?:au|par)\s+(?:kg|kilo|litre|unit[ée])/i;

  function clean(value, max) {
    if (typeof value !== "string") return null;
    var result = value.replace(/\s+/g, " ").trim();
    return result ? result.slice(0, max) : null;
  }
  function validGtin(value) {
    var digits = typeof value === "number" ? String(value) : value;
    if (typeof digits !== "string" || !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return null;
    var sum = 0;
    for (var i = digits.length - 2, multiplier = 3; i >= 0; i--, multiplier = multiplier === 3 ? 1 : 3)
      sum += Number(digits[i]) * multiplier;
    return (10 - sum % 10) % 10 === Number(digits[digits.length - 1]) ? digits : null;
  }
  function machinePrice(value) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== "string" || !/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) return null;
    var amount = Number(value.replace(",", "."));
    return amount > 0 ? amount : null;
  }
  function visiblePrice(value) {
    if (typeof value !== "string" || perUnit.test(value)) return null;
    var match = value.replace(/[\u00a0\u202f]/g, " ").match(/(?:€\s*(\d[\d .,]*)|(\d[\d .,]*)\s*€)/);
    if (!match) return null;
    var raw = (match[1] || match[2] || "").trim();
    var decimal = raw.match(/[.,](\d{1,2})$/);
    var whole = (decimal ? raw.slice(0, -decimal[0].length) : raw).replace(/\D/g, "");
    var amount = Number(whole + (decimal ? "." + decimal[1] : ""));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }
  function objects() {
    var result = [];
    function walk(value, depth) {
      if (!value || depth > 5 || result.length >= 150) return;
      if (Array.isArray(value)) { value.forEach(function (item) { walk(item, depth + 1); }); return; }
      if (typeof value !== "object") return;
      result.push(value);
      walk(value["@graph"], depth + 1);
      walk(value.mainEntity, depth + 1);
    }
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < Math.min(scripts.length, 25); i++) {
      try { walk(JSON.parse(scripts[i].textContent || ""), 0); } catch (_) { /* Other markup may still work. */ }
    }
    return result;
  }
  function isProduct(value) {
    var type = value && value["@type"];
    return typeof type === "string" ? /(?:^|\/)Product$/i.test(type)
      : Array.isArray(type) && type.some(function (item) { return typeof item === "string" && /(?:^|\/)Product$/i.test(item); });
  }
  function findProduct() {
    var matches = objects().filter(isProduct);
    if (matches.length === 1) return matches[0];
    if (headingText) {
      var normalized = headingText.toLocaleLowerCase();
      return matches.find(function (item) {
        var name = clean(item.name, 180);
        return name && (name.toLocaleLowerCase() === normalized || normalized.indexOf(name.toLocaleLowerCase()) >= 0);
      }) || null;
    }
    return null;
  }
  function first(selectors, read, root) {
    var scope = root || document;
    for (var i = 0; i < selectors.length; i++) {
      var nodes = scope.querySelectorAll(selectors[i]);
      for (var j = 0; j < Math.min(nodes.length, 30); j++) {
        var node = nodes[j];
        if (node.getClientRects && !node.getClientRects().length && !node.getAttribute("content")) continue;
        var value = read(node);
        if (value != null) return value;
      }
    }
    return null;
  }
  function field(node) { return node.getAttribute("content") || node.textContent || ""; }
  function shelfNearHeading(selectors) {
    var scope = heading;
    for (var i = 0; i < 4 && scope && scope.parentElement; i++) {
      scope = scope.parentElement;
      if (/^(MAIN|BODY|HTML)$/.test(scope.tagName || "")) break;
      var price = first(selectors, function (node) { return visiblePrice(node.textContent || ""); }, scope);
      if (price != null) return price;
    }
    return null;
  }

  var product = findProduct();
  var offer = product && (Array.isArray(product.offers) ? product.offers[0] : product.offers);
  var brand = product && product.brand;
  var name = clean(product && product.name, 180) || headingText;
  var ean = product && (validGtin(product.gtin13) || validGtin(product.gtin14)
    || validGtin(product.gtin12) || validGtin(product.gtin8) || validGtin(product.gtin));
  if (!ean) ean = first(['[itemprop="gtin13"]', '[itemprop="gtin"]', '[itemprop="gtin8"]'], function (node) { return validGtin(field(node)); });
  if (!ean && /(?:^|\.)intermarche\.com$/.test(host)) {
    var pathCode = location.pathname.match(/(?:^|\/)(\d{8}|\d{13})(?:\/|$)/);
    ean = pathCode && validGtin(pathCode[1]);
  }
  if (!ean && /(?:^|\.)auchan\.fr$/.test(host)) {
    var reference = (document.body && document.body.innerText || "").slice(0, 120000)
      .match(/R[eé]f\s*\/\s*EAN\s*:?\s*\d{1,12}\s*\/\s*(\d{8}|\d{13})(?!\d)/i);
    ean = reference && validGtin(reference[1]);
  }
  var quantity = clean(product && (product.weight || product.size || product.netContent), 100);
  if (!quantity && name) {
    var amount = name.match(/\b\d{1,4}(?:[.,]\d+)?\s*(?:kg|g|mg|ml|cl|dl|l)\b/i);
    quantity = amount ? amount[0] : null;
  }
  var price = null, source = null;
  if (/(?:^|\.)auchan\.fr$/.test(host)) {
    price = shelfNearHeading(['.price__now', '[data-testid="product-price"]']);
    if (price != null) source = "visible:auchan";
  } else {
    if (offer && (!offer.priceCurrency || String(offer.priceCurrency).toUpperCase() === "EUR")) {
      price = machinePrice(offer.price);
      if (price != null) source = "schema.org";
    }
    if (price == null) {
      var amount = first(['meta[itemprop="price"]', 'meta[property="product:price:amount"]'], function (node) { return machinePrice(field(node)); });
      var currency = first(['meta[itemprop="priceCurrency"]', 'meta[property="product:price:currency"]'], field);
      if (amount != null && (!currency || String(currency).toUpperCase() === "EUR")) { price = amount; source = "metadata"; }
    }
    if (price == null && /(?:^|\.)intermarche\.com$/.test(host)) {
      price = shelfNearHeading(['[data-testid="price"]', '.price-full', '.stime-product--footer__price', '.product-price']);
      if (price != null) source = "visible:intermarche";
    }
  }
  var payload = {
    v: 2, url: (location.origin + location.pathname).slice(0, 600), host: host.slice(0, 120),
    name: name, brand: clean(typeof brand === "string" ? brand : brand && brand.name, 100),
    ean: ean || null, quantity: quantity, price: price, source: source,
    capturedAt: new Date().toISOString()
  };
  if (window.__PRICE_CHECKER_V2_EXTRACT_ONLY__ === true) return payload;
  var target = destination + "#p=" + encodeURIComponent(JSON.stringify(payload));
  var opened = null;
  try { opened = window.open(target, "_blank"); } catch (_) { /* Popup blocked. */ }
  if (!opened) location.href = target;
})();
