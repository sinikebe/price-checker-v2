import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fire, h, loadModule, render, startDom } from "./fixtures/react-harness.mjs";

const dom = startDom();
const require = createRequire(import.meta.url);
const { default: V2Info } = await loadModule("V2Info.tsx", { "react-dom": require("react-dom"), "./V2SiteIcons": { InfoIcon: () => null } });
const buttons = () => [...document.querySelectorAll("button.v2-info-button")];
const bubbles = () => [...document.querySelectorAll(".v2-info-bubble")];
const shown = () => bubbles().filter(bubble => !bubble.hidden).map(bubble => bubble.textContent);
const expanded = button => button.getAttribute("aria-expanded");
const pointer = (target, type, pointerType = "mouse") => fire(target, type, { pointerType });
const page = (...texts) => h("main", null, texts.map(text => h(V2Info, { key: text }, text)));

test("a bubble opens on click, closes on a second click, and its text always describes the button", async () => {
  const view = await render(page("Comment filtrer"));
  const [button] = buttons();
  assert.equal(button.getAttribute("aria-label"), "Aide");
  assert.deepEqual(shown(), [], "closed at first");
  assert.equal(bubbles()[0].textContent, "Comment filtrer", "closed, the text stays in the page");
  assert.equal(button.getAttribute("aria-describedby"), bubbles()[0].id, "and describes the button");

  await fire(button, "click");
  assert.deepEqual(shown(), ["Comment filtrer"]);
  assert.equal(expanded(button), "true");
  await fire(button, "click");
  assert.deepEqual(shown(), []);
  assert.equal(expanded(button), "false");
  await view.unmount();
  assert.deepEqual(bubbles().length, 0, "nothing is left under body once the page changes");
});

test("Escape closes the bubble and gives the focus back to its button; a click elsewhere closes it too", async () => {
  const view = await render(page("Aide de la page"));
  const [button] = buttons();
  await fire(button, "click");
  await fire(document, "keydown", { key: "Escape" });
  assert.deepEqual(shown(), []);
  assert.equal(dom.focused.at(-1)?.getAttribute("aria-label"), "Aide");

  await fire(button, "click");
  await fire(bubbles()[0], "pointerdown");
  assert.deepEqual(shown(), ["Aide de la page"], "a click in the bubble keeps it open, to follow its links");
  await fire(document.body, "pointerdown");
  assert.deepEqual(shown(), []);
  await view.unmount();
});

test("only one bubble is open at a time", async () => {
  const view = await render(page("Premier", "Second"));
  const [first, second] = buttons();
  await fire(first, "click");
  await fire(second, "click");
  assert.deepEqual(shown(), ["Second"]);
  assert.equal(expanded(first), "false");
  await view.unmount();
});

test("a mouse opens the bubble while it rests on the button; a finger does not, it taps", async () => {
  const view = await render(page("Au survol"));
  const [button] = buttons();
  await pointer(button, "pointerover", "touch");
  assert.deepEqual(shown(), [], "no hover on a touch screen");
  await pointer(button, "pointerover");
  assert.deepEqual(shown(), ["Au survol"]);
  await view.unmount();
});

test("clicking the button inside a label or a summary does nothing else", async () => {
  const clicks = [];
  const view = await render(h("label", { onClick: () => clicks.push("label") }, "Pseudo", h(V2Info, null, "Trois caractères")));
  const [button] = buttons();
  const event = new window.Event("click", { bubbles: true, cancelable: true });
  const { act } = await import("./fixtures/react-harness.mjs");
  await act(async () => { button.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, true, "the label does not activate its field");
  assert.deepEqual(clicks, [], "and the click stops at the button");
  await fire(document.body, "pointerdown");
  await view.unmount();
});

test("a visible label names the bubble where no title gives it context", async () => {
  const view = await render(h(V2Info, { label: "Légende des couleurs", showLabel: true }, "Vert = bas"));
  const [button] = buttons();
  assert.equal(button.getAttribute("aria-label"), null, "the visible text is its name");
  assert.equal(button.textContent, "Légende des couleurs");
  await view.unmount();
});
