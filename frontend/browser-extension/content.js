/* Runs on www.carrefour.fr in the visitor's own browser. It only answers the extension's own popup, one
 * product at a time, with a normal same-site request made with the visitor's own session and store. */
(function () {
  "use strict";
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;
  chrome.runtime.onMessage.addListener(function (message, sender, reply) {
    if (sender.id !== chrome.runtime.id || !message || message.type !== "read-ean") return false;
    var ean = typeof message.ean === "string" && /^\d{8,14}$/.test(message.ean) ? message.ean : null;
    if (!ean) { reply({ ok: false, error: "EAN invalide." }); return false; }
    fetch("/s?q=" + encodeURIComponent(ean), {
      credentials: "same-origin", redirect: "follow",
      headers: { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" }
    }).then(function (response) {
      return response.text().then(function (text) {
        var parsed = self.PriceCheckerCarrefour.parseSearch(text.slice(0, 4000000), ean);
        reply({
          ok: response.ok, status: response.status, contentType: response.headers.get("content-type") || "", bytes: text.length,
          challenge: response.status === 403 || /Just a moment|cf-mitigated|captcha/i.test(text.slice(0, 4000)),
          pageUrl: location.href, parsed: parsed
        });
      });
    }).catch(function (error) { reply({ ok: false, error: String(error && error.message || error).slice(0, 200) }); });
    return true;
  });
})();
