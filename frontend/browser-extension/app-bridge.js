/* Runs on this instance's own pages only (the manifest handed out by the instance names its address).
 * It lets the basket page ask the extension to read prices, and relays progress back to the page.
 * Nothing is trusted from the page beyond a checked job: no address, no code, no credential. */
(function () {
  "use strict";
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.connect) return;
  var origin = location.origin;
  var core = self.PriceCheckerCore;
  var port = null;
  var beat = null;

  function toPage(message) {
    window.postMessage(Object.assign({ source: "pc-ext" }, message), origin);
  }
  function close() {
    if (beat) { clearInterval(beat); beat = null; }
    port = null;
  }
  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "app-bridge" });
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(function () { if (port) toPage({ type: "aborted", reason: "extension_stopped" }); close(); });
    // A running job keeps the extension's worker awake through this regular sign of life.
    beat = setInterval(function () { try { port.postMessage({ type: "beat" }); } catch (error) { close(); } }, 20000);
    return port;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || event.origin !== origin) return;
    var data = event.data;
    if (!data || data.source !== "pc-app" || typeof data.type !== "string") return;
    if (data.type === "ping") {
      toPage({ type: "pong", id: String(data.id || "").slice(0, 64), version: chrome.runtime.getManifest().version, adapters: ["carrefour"] });
    } else if (data.type === "refresh") {
      var job = core.validJob(data);
      if (!job) { toPage({ type: "aborted", id: String(data.id || "").slice(0, 64), reason: "invalid_job" }); return; }
      connect().postMessage(job);
    } else if (data.type === "cancel" && port) {
      port.postMessage({ type: "cancel" });
    }
  });
})();
