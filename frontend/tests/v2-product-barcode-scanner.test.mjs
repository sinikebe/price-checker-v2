import assert from "node:assert/strict";
import { test } from "node:test";
import { fire, h, loadModule, render, startDom } from "./fixtures/react-harness.mjs";

const dom = startDom();
// Node has no camera: the page is not a secure context, so the scanner offers the manual entry at once.
globalThis.MediaStream = class MediaStream {};
const search = await loadModule("v2-catalogue-search.ts");
const { default: V2BarcodeScanner } = await loadModule("V2BarcodeScanner.tsx", { "./v2-catalogue-search": search });
const button = name => [...document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === name || item.textContent === name);
// The focused element by its accessible name (see the harness about asserting on nodes).
const focusedName = () => { const element = dom.focused.at(-1); return element?.getAttribute("aria-label") || element?.textContent; };

test("the scanner keeps the reader's focus when its page renders again, and Escape closes it", async () => {
  const closed = [];
  const scanner = onClose => h(V2BarcodeScanner, { onClose, onDetected: () => {} });
  // Each parent render passes a new close function, as `onClose={() => setScannerOpen(false)}` does.
  const view = await render(scanner(() => closed.push("first")));
  assert.equal(focusedName(), "Fermer le scanner", "the dialog opens with focus on its close button");

  button("Saisir le code manuellement").focus();
  await view.update(scanner(() => closed.push("second")));
  assert.equal(focusedName(), "Saisir le code manuellement", "a new render does not move the focus back");
  assert.equal(dom.focused.filter(item => item === button("Fermer le scanner")).length, 1);

  await fire(document, "keydown", { key: "Escape" });
  assert.deepEqual(closed, ["second"], "Escape uses the page's current close function");
  await view.unmount();
  await fire(document, "keydown", { key: "Escape" });
  assert.deepEqual(closed, ["second"], "closed: Escape is no longer listened to");
});
