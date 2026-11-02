/* Runs on www.carrefour.fr in the visitor's own browser. It only answers the extension's own popup, one
 * product at a time, with a normal same-site request made with the visitor's own session and store. */
(function () {
  "use strict";
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;
  chrome.runtime.onMessage.addListener(function (message, sender, reply) {
    if (sender.id !== chrome.runtime.id || !message || message.type !== "read-ean") return false;
    var ean = typeof message.ean === "string" && /^\d{8,14}$/.test(message.ean) ? message.ean : null;
    if (!ean) { reply({ ok: false, error: "EAN invalide." }); return false; }
    var parse = self.PriceCheckerCarrefour;
    var headers = { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" };
    fetch("/s?q=" + encodeURIComponent(ean), { credentials: "same-origin", redirect: "follow", headers: headers }).then(function (response) {
      return response.text().then(function (text) {
        var parsed = parse.parseSearch(text.slice(0, 4000000), ean);
        var answer = {
          ok: response.ok, status: response.status, contentType: response.headers.get("content-type") || "", bytes: text.length,
          challenge: response.status === 403 || /Just a moment|cf-mitigated|captcha/i.test(text.slice(0, 4000)),
          pageUrl: location.href, parsed: parsed
        };
        var first = parsed.matches[0];
        var url = first && parse.productPageUrl(first.url, ean);
        if (!response.ok || answer.challenge || !url) return answer;
        // The product page carries the price (schema.org data) and the store the visitor has chosen.
        return fetch(url.replace("https://www.carrefour.fr", ""), { credentials: "same-origin", redirect: "follow", headers: { accept: "text/html" } }).then(function (page) {
          return page.text().then(function (html) {
            var product = parse.parseProductPage(html.slice(0, 6000000), ean);
            answer.page = { status: page.status, bytes: html.length, found: product.found, store: product.storeLabel, slug: product.storeSlug, seller: product.seller, available: product.available };
            answer.challenge = answer.challenge || page.status === 403 || /Just a moment|cf-mitigated/i.test(html.slice(0, 4000));
            if (product.found) {
              first.title = product.title || first.title;
              first.url = product.url || url;
              first.prices = product.prices;
              first.price = product.price;
              first.store = product.storeLabel;
              first.storeSlug = product.storeSlug;
              first.seller = product.seller;
              first.available = product.available;
            } else first.url = url;
            return answer;
          });
        });
      });
    }).then(reply).catch(function (error) { reply({ ok: false, error: String(error && error.message || error).slice(0, 200) }); });
    return true;
  });
})();
