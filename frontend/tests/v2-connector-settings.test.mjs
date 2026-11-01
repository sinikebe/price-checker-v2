import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-connector-settings.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { initialDraft, readableValues, secretHint, settingsPayload } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const fields = [
  { key: "api_key", label: "Clé", type: "secret", configured: true },
  { key: "enabled", label: "On", type: "boolean" },
  { key: "days", label: "Jours", type: "integer", min: 1, max: 30 },
];

test("a secret value is never kept from what the server sends, even if it sent one", () => {
  assert.deepEqual(readableValues(fields, { api_key: "pmx_leak", enabled: true, days: 7 }), { enabled: true, days: 7 });
});

test("the form starts with an empty entry for each secret and the saved other values", () => {
  assert.deepEqual(initialDraft(fields, { enabled: true, days: 7 }), { enabled: true, days: 7, api_key: "" });
});

test("every field is sent once and an untouched secret goes as an empty string so the stored one stays", () => {
  assert.deepEqual(settingsPayload(fields, { enabled: false, days: 3, api_key: "" }), { api_key: "", enabled: false, days: 3 });
  assert.deepEqual(settingsPayload(fields, { enabled: false, days: 3 }), { api_key: "", enabled: false, days: 3 });
  assert.equal(settingsPayload(fields, { enabled: true, days: 3, api_key: "pmx_new_key" }).api_key, "pmx_new_key");
  assert.deepEqual(Object.keys(settingsPayload(fields, { stray: 1, enabled: true, days: 1, api_key: "" })), ["api_key", "enabled", "days"]);
});

test("the hint says whether a key is stored, never what it is", () => {
  assert.match(secretHint({ ...fields[0], configured: true }), /laissez vide pour la conserver/);
  assert.match(secretHint({ ...fields[0], configured: false }), /Aucune clé/);
});
