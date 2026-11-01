/* Popup: settings, then "read this EAN on the open carrefour.fr tab" and "propose the price". */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var config = null;
  var last = null;

  function say(text, kind) { var el = $("message"); el.textContent = text || ""; el.className = kind || ""; }
  function show(which) { $("setup").hidden = which !== "setup"; $("main").hidden = which !== "main"; }

  function instanceOrigin(value) {
    try {
      var url = new URL(String(value).trim());
      var local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
      return url.origin;
    } catch (error) { return null; }
  }
  async function api(path, options) {
    var response = await fetch(config.instance + path, Object.assign({ cache: "no-store" }, options, {
      headers: Object.assign({ accept: "application/json", authorization: "Bearer " + config.token }, options && options.body ? { "content-type": "application/json" } : {})
    }));
    var body = null;
    try { body = await response.json(); } catch (error) { /* no body */ }
    if (!response.ok) {
      var detail = body && typeof body.detail === "string" ? body.detail : "Erreur " + response.status + ".";
      var failure = new Error(detail); failure.status = response.status; throw failure;
    }
    return body;
  }

  async function save() {
    var origin = instanceOrigin($("instance").value);
    var token = $("token").value.trim();
    var storeId = Number($("store").value);
    if (!origin) return say("Adresse invalide : https:// obligatoire (http:// seulement pour localhost).", "bad");
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) return say("Jeton invalide.", "bad");
    if (!Number.isSafeInteger(storeId) || storeId < 1) return say("Numéro de magasin invalide.", "bad");
    var granted = await chrome.permissions.request({ origins: [origin + "/*"] });
    if (!granted) return say("Autorisation refusée : l’extension doit pouvoir joindre votre instance.", "bad");
    config = { instance: origin, token: token, store: null };
    try {
      var store = await api("/api/v2/stores/" + storeId);
      config.store = { id: store.id, name: store.name, retailer: store.retailer, city: store.city || "", postal_code: store.postal_code || "" };
    } catch (error) { config = null; return say("Instance ou magasin introuvable : " + error.message, "bad"); }
    await chrome.storage.local.set({ config: config });
    say("Enregistré.", "good");
    enter();
  }

  function enter() {
    show("main");
    $("where").textContent = config.store.retailer + " · " + config.store.name + (config.store.city ? " · " + config.store.city : "") + "  →  " + config.instance;
    chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var url = tabs[0] && tabs[0].url || "";
      var match = url.match(/(\d{8,14})(?:[/?#]|$)/);
      if (match && !$("ean").value) $("ean").value = match[1];
    });
  }

  function clear() { $("result").textContent = ""; $("diag").hidden = true; last = null; say(""); }

  function render(answer) {
    var box = $("result"); box.textContent = "";
    var summary = { status: answer.status, contentType: answer.contentType, bytes: answer.bytes, challenge: answer.challenge,
      topKeys: answer.parsed && answer.parsed.topKeys, looked: answer.parsed && answer.parsed.looked,
      page: answer.page, matches: (answer.parsed && answer.parsed.matches || []).map(function (m) { return { title: m.title, prices: m.prices, hints: m.hints, url: m.url, store: m.store }; }) };
    $("diagText").textContent = JSON.stringify(summary, null, 1); $("diag").hidden = false;
    if (answer.challenge) return say("Carrefour demande une vérification : ouvrez la page dans l’onglet, validez-la, puis réessayez. Rien n’est contourné.", "bad");
    if (!answer.ok) return say(answer.error ? "Échec : " + answer.error : "Carrefour a répondu " + answer.status + ".", "bad");
    var matches = answer.parsed && answer.parsed.matches || [];
    if (!matches.length) return say("Aucun produit avec cet EAN dans la réponse (réponse lue : " + answer.bytes + " octets). Ouvrez les détails techniques.", "bad");
    last = { answer: answer, matches: matches };
    matches.forEach(function (match, index) {
      var card = document.createElement("div"); card.className = "match";
      var title = document.createElement("b"); title.textContent = match.title || "(sans titre)"; card.appendChild(title);
      if (match.store || match.seller) {
        var where = document.createElement("div"); where.className = "muted";
        where.textContent = "Magasin sur la page : " + [match.store, match.seller].filter(Boolean).join(" · ") + (match.available === false ? " · indisponible" : "");
        card.appendChild(where);
      }
      if (!match.prices.length) { var none = document.createElement("div"); none.className = "bad"; none.textContent = "Aucun prix reconnu."; card.appendChild(none); }
      match.prices.forEach(function (price, p) {
        var label = document.createElement("label"); var radio = document.createElement("input");
        radio.type = "radio"; radio.name = "price"; radio.value = index + ":" + p; radio.checked = index === 0 && p === 0;
        label.appendChild(radio); label.appendChild(document.createTextNode(" " + price.value.toFixed(2).replace(".", ",") + " €  (" + price.path + ")"));
        card.appendChild(label);
      });
      box.appendChild(card);
    });
    var send = document.createElement("button"); send.type = "button"; send.textContent = "Proposer ce prix à l’application";
    send.addEventListener("click", function () { propose(send); }); box.appendChild(send);
    say("Vérifiez le prix affiché sur la page avant de l’envoyer.");
  }

  async function read() {
    clear();
    var ean = $("ean").value.trim();
    if (!/^\d{8,14}$/.test(ean)) return say("EAN invalide.", "bad");
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab || !/^https:\/\/www\.carrefour\.fr\//.test(tab.url || "")) return say("Ouvrez carrefour.fr (avec votre drive choisi) dans l’onglet actif.", "bad");
    $("read").disabled = true; say("Lecture…");
    try {
      render(await chrome.tabs.sendMessage(tab.id, { type: "read-ean", ean: ean }));
    } catch (error) {
      say("La page ne répond pas : rechargez l’onglet carrefour.fr puis réessayez.", "bad");
    } finally { $("read").disabled = false; }
  }

  async function propose(button) {
    var chosen = document.querySelector("input[name=price]:checked");
    if (!chosen || !last) return say("Choisissez un prix.", "bad");
    var pair = chosen.value.split(":").map(Number);
    var match = last.matches[pair[0]]; var price = match.prices[pair[1]];
    button.disabled = true; say("Envoi…");
    try {
      var product = await api("/api/v2/products/by-barcode/" + encodeURIComponent(match.ean));
      if (product.kind !== "product") throw new Error("Ce code-barres n’est pas encore un produit publié.");
      var store = config.store;
      var created = await api("/api/v2/prices/products/" + product.id + "/capture-drafts", { method: "POST", body: JSON.stringify({
        ean: match.ean, source_url: match.url || "https://www.carrefour.fr/s?q=" + match.ean,
        price: { retailer: store.retailer, store_name: store.name, city: store.city, postal_code: store.postal_code, sales_channel: "drive",
          price: price.value, observed_at: new Date().toISOString(), note: "Relevé par l’extension navigateur", store_id: store.id, captured_store_name: match.store || null } }) });
      say("Proposition n° " + created.id + " créée : à valider dans l’application.", "good");
    } catch (error) {
      say(error.status === 404 ? "Ce code-barres est inconnu du catalogue." : error.message, "bad");
      button.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    $("save").addEventListener("click", function () { save().catch(function (e) { say(String(e.message || e), "bad"); }); });
    $("read").addEventListener("click", function () { read().catch(function (e) { say(String(e.message || e), "bad"); }); });
    $("reset").addEventListener("click", function (event) { event.preventDefault(); chrome.storage.local.remove("config").then(function () { config = null; clear(); show("setup"); }); });
    // The copy handed out by an instance carries that instance's address, so it need not be typed.
    fetch(chrome.runtime.getURL("instance.json")).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      var origin = data && instanceOrigin(data.instance);
      if (origin && !$("instance").value) $("instance").value = origin;
    }).catch(function () { /* the plain copy has no such file */ });
    var stored = await chrome.storage.local.get("config");
    if (stored.config && stored.config.instance && stored.config.token && stored.config.store) { config = stored.config; enter(); } else show("setup");
  });
})();
