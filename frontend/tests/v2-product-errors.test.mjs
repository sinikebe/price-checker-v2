import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-product-errors.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { productErrorText } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const generic = "L'opération a échoué.";

test("a plain detail is shown as it is", () => {
  assert.equal(productErrorText("Le champ nom est nécessaire pour publier."), "Le champ nom est nécessaire pour publier.");
});

test("the French message of a rule the server checks is shown without its technical prefix", () => {
  const detail = [{ type: "value_error", loc: ["body", "data"], msg: "Value error, Cette unité est déjà donnée par la quantité." }];
  assert.equal(productErrorText(detail), "Cette unité est déjà donnée par la quantité.");
});

test("built-in validation messages and unknown bodies stay generic", () => {
  assert.equal(productErrorText([{ type: "greater_than", msg: "Input should be greater than 0" }]), generic);
  for (const detail of [null, undefined, 3, {}, [], [null], [{ type: "value_error", msg: 4 }]]) assert.equal(productErrorText(detail), generic);
  assert.equal(productErrorText([{ type: "value_error", msg: "Value error, " }]), generic);
  assert.ok(productErrorText([{ type: "value_error", msg: "x".repeat(1000) }]).length <= 300);
});
