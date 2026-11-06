import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Stylesheet checks for the dark theme: they guard against overrides that never apply, colours that
// stay unreadable on the dark cards, and custom properties that nothing defines (always their fallback).
const dir = new URL("../src/v2/", import.meta.url);
const read = name => readFileSync(new URL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const stylesheets = readdirSync(dir).filter(name => name.endsWith(".css")).map(read);
const scripts = readdirSync(dir).filter(name => /\.tsx?$/.test(name)).map(read);
const DARK = 'html[data-v2-theme="dark"]';

/** Splits on the commas that are not inside parentheses or brackets. */
function splitTop(text) {
  const parts = [];
  let depth = 0, current = "";
  for (const char of text) {
    if ("([".includes(char)) depth++;
    if (")]".includes(char)) depth--;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += char;
  }
  return [...parts, current.trim()].filter(Boolean);
}

/** Every style rule as { selectors, body }; the rules inside @media blocks are included. */
function rules(css) {
  return [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map(([, head, body]) => ({ selectors: splitTop(head.trim()), body }));
}

/** CSS specificity [ids, classes, types] of a selector, with :is()/:not()/:has() counting their most specific argument. */
function specificity(selector) {
  let ids = 0, classes = 0, types = 0, i = 0;
  const add = ([a, b, c]) => { ids += a; classes += b; types += c; };
  const max = list => list.map(specificity).reduce((best, next) => compare(next, best) > 0 ? next : best, [0, 0, 0]);
  while (i < selector.length) {
    const rest = selector.slice(i);
    const functional = rest.match(/^:(is|not|has|where)\(/);
    if (functional) {
      let depth = 1, j = functional[0].length;
      while (depth) { if (rest[j] === "(") depth++; if (rest[j] === ")") depth--; j++; }
      if (functional[1] !== "where") add(max(splitTop(rest.slice(functional[0].length, j - 1))));
      i += j;
    } else if (rest.startsWith("[")) { classes++; i += rest.indexOf("]") + 1; }
    else if (rest.startsWith("::")) { types++; i += rest.match(/^::[\w-]+/)[0].length; }
    else if (/^[.:#][\w-]/.test(rest)) { rest[0] === "#" ? ids++ : classes++; i += rest.match(/^[.:#][\w-]+(\([^)]*\))?/)[0].length; }
    else if (/^[a-z]/i.test(rest)) { types++; i += rest.match(/^[\w-]+/)[0].length; }
    else i++;
  }
  return [ids, classes, types];
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const darkRules = stylesheets.flatMap(rules).flatMap(rule => rule.selectors
  .filter(selector => selector.startsWith(DARK + " "))
  .map(selector => ({ selector: selector.slice(DARK.length + 1).trim(), body: rule.body })));
/** The dark rule whose selector, or one of its :is() arguments, is exactly `target`. */
function darkRule(target) {
  return darkRules.find(({ selector }) => selector === target
    || (selector.startsWith(":is(") && selector.endsWith(")") && splitTop(selector.slice(4, -1)).includes(target)));
}
const declared = (body, property) => body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!]+)`))?.[1].trim();

function contrast(foreground, background) {
  const luminance = hex => {
    const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map(part => parseInt(part, 16) / 255)
      .map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

test("every custom property a stylesheet or a component reads is defined somewhere", () => {
  const sources = [...stylesheets, ...scripts].join("\n");
  const used = new Set([...sources.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]));
  const defined = new Set([...sources.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  assert.deepEqual([...used].filter(name => !defined.has(name)), []);
});

test("the dark style of the dimmed fields outranks the dark style of every field", () => {
  const field = darkRules.find(({ selector }) => selector.startsWith(".v2-home :is(input:not("));
  const dimmed = darkRules.find(({ selector }) => selector.includes("input[readonly]"));
  assert.ok(field && dimmed);
  assert.ok(compare(specificity(DARK + " " + dimmed.selector), specificity(DARK + " " + field.selector)) > 0,
    "a read-only field would keep the plain dark field colours");
  assert.deepEqual(specificity(DARK + " " + field.selector), [0, 4, 2]);
});

test("texts styled for the light theme get a readable dark colour", () => {
  // The dark backgrounds these texts sit on: page, cards, and the Open Food Facts and barcode panels.
  const backgrounds = ["#101b19", "#1b2d28", "#20362d"];
  const muted = declared(darkRules.find(({ selector }) => selector === ".v2-home").body, "--v2-muted");
  const cases = {
    link: [".v2-auth-switch a", ".v2-auth-back", ".v2-auth-legal a", ".v2-off-mark", ".v2-off-selected button", ".v2-price-draft-inbox-actions a"],
    muted: [".v2-auth-switch", ".v2-auth-legal", ".v2-install-message", ".v2-price-draft-inbox h2 span", ".v2-price-draft-inbox-list small",
      ".v2-extension-product p", ".v2-stores-source", ".v2-stores-inactive"],
    error: [".v2-off-error", '.v2-barcode-search p[role="alert"]', '.v2-scanner-dialog p[role="alert"]', ".v2-basket-quantity small",
      ".v2-completion-store-form p"],
  };
  const lightRules = stylesheets.flatMap(rules);
  for (const [kind, selectors] of Object.entries(cases)) for (const selector of selectors) {
    // A muted text may also follow the dark value of the shared token through its light rule.
    const rule = darkRule(selector) ?? (kind === "muted" ? lightRules.find(({ selectors }) => selectors.includes(selector)) : undefined);
    assert.ok(rule, `${selector} has no dark colour`);
    const color = declared(rule.body, "color");
    const value = color === "var(--v2-muted)" ? muted : color;
    assert.match(value, /^#[0-9a-f]{6}$/i, selector);
    for (const background of backgrounds) assert.ok(contrast(value, background) >= 4.5, `${selector} on ${background}`);
  }
});

test("light-only surfaces of the catalogue, the price inbox and the connector list have a dark style", () => {
  for (const selector of [".v2-catalogue-suggestions", ".v2-catalogue-suggestions button", ".v2-catalogue-pagination button",
    ".v2-price-draft-inbox-actions button", ".v2-price-draft-inbox-pages button", ".v2-price-draft-inbox-list li",
    ".v2-catalogue-classification", ".v2-connector-store", ".v2-workspace-section-title"])
    assert.ok(darkRule(selector), `${selector} keeps its light colours in the dark theme`);
});
