import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-view.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { savingText } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const plain = text => text.replace(/[  ]/g, " ");

test("a store that lowers the basket says how much, and what share of the price without it", () => {
  const note = savingText({ extraCents: 120, unpriced: 0 }, 3880, false);
  assert.equal(note.kind, "saving");
  assert.equal(plain(note.text), "Économie grâce à ce magasin : 1,20 € (3 %)");
  assert.equal(plain(savingText({ extraCents: 1, unpriced: 0 }, 100000, false).text), "Économie grâce à ce magasin : 0,01 € (1 %)", "never shown as 0 %");
});

test("a store whose prices are matched elsewhere brings no saving", () => {
  assert.deepEqual(savingText({ extraCents: 0, unpriced: 0 }, 1000, false), { kind: "none", text: "Aucune économie : les mêmes prix existent ailleurs" });
});

test("a store that alone prices some articles is not compared on them", () => {
  assert.equal(savingText({ extraCents: 0, unpriced: 1 }, 1000, false).text, "Seul magasin avec un prix pour 1 article");
  assert.equal(plain(savingText({ extraCents: 50, unpriced: 2 }, 1000, false).text),
    "Seul magasin avec un prix pour 2 articles · économie sur les autres articles : 0,50 €");
  assert.deepEqual(savingText({ extraCents: 0, unpriced: 4 }, 1000, true), { kind: "only", text: "Seul magasin avec un prix pour ce panier" });
});
