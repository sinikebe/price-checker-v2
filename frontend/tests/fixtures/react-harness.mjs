// Renders a component of the app in Node, for the tests of what it does on screen: a linkedom document,
// the real React, and the module's other imports replaced by the stubs (or modules) a test gives. Nothing
// is bundled here, so every import of the loaded file must be given, except React and its stylesheets.
// Assert on texts or names, not on DOM nodes: a failed assertion prints its values, and printing a
// linkedom node takes forever.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { createRoot } = require("react-dom/client");
const { parseHTML } = require("linkedom");

export const { act, createElement: h, Fragment } = React;
const BUILT_IN = { react: React, "react/jsx-runtime": require("react/jsx-runtime") };
const registry = (globalThis.__reactHarness ??= []);

/** A fresh document as the page's `window` and `document`; `focused` lists every element focused. */
export function startDom() {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  const focused = [];
  // linkedom does not track focus: it is recorded here instead.
  window.HTMLElement.prototype.focus = function focus() { focused.push(this); };
  globalThis.window = window;
  globalThis.document = document;
  // Node's own events cannot be dispatched on linkedom's nodes.
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { window, document, focused };
}

// `X`, `{ a, b as c }`, `X, { a }` or `* as X`, as a destructuring pattern.
function pattern(clause) {
  const namespace = clause.match(/^\*\s+as\s+(\w+)$/);
  if (namespace) return namespace[1];
  const [, name, named] = clause.match(/^(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?$/) ?? [];
  const parts = name ? ["default: " + name] : [];
  for (const item of (named ?? "").split(",").map(part => part.trim()).filter(Boolean)) {
    const [imported, local] = item.split(/\s+as\s+/);
    parts.push(local ? `${imported}: ${local}` : imported);
  }
  return "{ " + parts.join(", ") + " }";
}

/** A source file, by its path from src/v2, compiled, with its imports read from `modules` by specifier. */
export async function loadModule(file, modules = {}) {
  const source = readFileSync(new URL("../../src/v2/" + file, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const known = { ...BUILT_IN, ...modules };
  const slot = registry.push(known) - 1;
  const code = output
    .replace(/^import\s+"[^"]+\.css";$/gm, "")
    .replace(/^import\s+([\s\S]+?)\s+from\s+"([^"]+)";$/gm, (_, clause, specifier) => {
      if (!(specifier in known)) throw new Error(`${file}: no module given for "${specifier}"`);
      return `const ${pattern(clause)} = globalThis.__reactHarness[${slot}][${JSON.stringify(specifier)}];`;
    });
  if (/^import\s/m.test(code)) throw new Error(`${file}: an import was not replaced`);
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

/** Renders an element in a new container of the page; `update` renders another one in its place. */
export async function render(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    update: element => act(async () => { root.render(element); }),
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

/** Lets pending promises (stubbed requests) settle and React apply what they set. */
export const settle = () => act(async () => { for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0)); });

/** Dispatches a DOM event the way a browser would for a user action. */
export function fire(target, type, init = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, init);
  return act(async () => { target.dispatchEvent(event); });
}
