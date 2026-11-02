/* The extension's worker: reads the prices of one job, one product at a time, in a tab on the retailer's
 * site, with the person's own session and store. It stops at the first sign of a check it cannot pass by
 * itself and waits for the person: nothing is solved or worked around here. */
importScripts("carrefour-parse.js", "extension-core.js");

var SITE = "https://www.carrefour.fr/";
var core = self.PriceCheckerCore;
var running = null;

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function findTab(job) {
  var tabs = await chrome.tabs.query({ url: SITE + "*" });
  if (tabs.length) return tabs[0];
  var tab = await chrome.tabs.create({ url: SITE, active: false });
  job.createdTab = tab.id;
  var started = Date.now();
  while (Date.now() - started < 30000) {
    var current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") break;
    await sleep(500);
  }
  await sleep(1500);
  return chrome.tabs.get(tab.id);
}

async function ask(tabId, ean) {
  for (var attempt = 0; attempt < 5; attempt++) {
    try { return await chrome.tabs.sendMessage(tabId, { type: "read-ean", ean: ean }); }
    catch (error) { await sleep(1000); }
  }
  return { ok: false, error: "the page does not answer" };
}

async function readOne(job, item, send) {
  var tab = await findTab(job);
  var result = core.classify(await ask(tab.id, item.ean), job.verified);
  var waited = 0;
  while (result.outcome === "challenge" && !job.cancelled && waited < 600000) {
    // The site wants the person: bring its tab forward and wait, then carry on by itself.
    if (waited === 0) {
      send({ type: "needs-human" });
      try { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch (error) { /* the person finds the tab */ }
    }
    await sleep(8000); waited += 8000;
    result = core.classify(await ask(tab.id, item.ean), job.verified);
  }
  if (result.outcome === "challenge") return { outcome: "error", detail: "still waiting for the check" };
  if (waited) send({ type: "resumed" });
  return result;
}

async function run(port, request) {
  if (running) { port.postMessage({ type: "aborted", id: request.id, reason: "busy" }); return; }
  var job = { id: request.id, cancelled: false, verified: false, createdTab: null };
  running = job;
  var send = function (message) { try { port.postMessage(Object.assign({ id: request.id }, message)); } catch (error) { job.cancelled = true; } };
  try {
    send({ type: "started", total: request.items.length });
    var errors = 0;
    for (var index = 0; index < request.items.length; index++) {
      if (job.cancelled) { send({ type: "aborted", reason: "cancelled" }); return; }
      var item = request.items[index];
      var result = await readOne(job, item, send);
      if (result.outcome === "price") {
        if (!core.storeMatches(result.storeSlug, request.storeHint)) {
          send({ type: "aborted", reason: "wrong_store", store: result.storeLabel || null });
          return;
        }
        job.verified = true;
      }
      errors = result.outcome === "error" ? errors + 1 : 0;
      send({ type: "progress", done: index + 1, total: request.items.length, item: Object.assign({ product_id: item.product_id, ean: item.ean }, result) });
      if (errors >= 3) { send({ type: "aborted", reason: "errors" }); return; }
      if (index + 1 < request.items.length) await sleep(core.pause());
    }
    send({ type: "done" });
  } finally {
    if (job.createdTab !== null) { try { await chrome.tabs.remove(job.createdTab); } catch (error) { /* already closed */ } }
    running = null;
  }
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "app-bridge" || port.sender.id !== chrome.runtime.id) { port.disconnect(); return; }
  port.onMessage.addListener(function (message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "cancel" && running) running.cancelled = true;
    else if (message.type === "refresh") {
      var request = core.validJob(message);
      if (request) run(port, request); else port.postMessage({ type: "aborted", reason: "invalid_job" });
    }
  });
  port.onDisconnect.addListener(function () { if (running) running.cancelled = true; });
});
