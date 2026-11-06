import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-duplicate-query.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { DUPLICATE_QUERY_MAX_LENGTH, originQuery } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("the first candidate search is the reported name, or a store's city", () => {
  assert.equal(originQuery({ name: "Lait demi-écrémé", city: "Lyon" }), "Lait demi-écrémé");
  assert.equal(originQuery({ city: "Lyon" }), "Lyon");
  assert.equal(originQuery({ name: null, city: null }), "");
  assert.equal(originQuery({}), "");
});

test("a product name longer than the server's search limit is cut to fit", () => {
  // Product names allow 160 characters; the candidate search accepts 100 (a longer one was refused).
  assert.equal(DUPLICATE_QUERY_MAX_LENGTH, 100);
  const name = "é".repeat(160);
  assert.equal(originQuery({ name }), "é".repeat(100));
  assert.equal(originQuery({ name: "x".repeat(100) }), "x".repeat(100));
  // Counted in UTF-16 units: never more characters than the server counts.
  assert.equal(originQuery({ name: "🥛".repeat(80) }), "🥛".repeat(50));
  // A character is never cut in half, which encodeURIComponent would refuse.
  const shifted = originQuery({ name: "a" + "🥛".repeat(80) });
  assert.equal(shifted, "a" + "🥛".repeat(49));
  assert.doesNotThrow(() => encodeURIComponent(shifted));
});
