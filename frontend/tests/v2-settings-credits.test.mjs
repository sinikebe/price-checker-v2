import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-credit-settings.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { CREDIT_FIELDS, creditSummary, readAmounts, saveCreditSettings } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const settings = { daily_grant: 50, hold_max: 100, visitor_daily: 10, revision: 3,
  bounds: { daily_grant: { min: 0, max: 1000 }, hold_max: { min: 1, max: 10000 }, visitor_daily: { min: 0, max: 1000 } } };

test("the three amounts are whole numbers within their bounds", () => {
  assert.deepEqual(CREDIT_FIELDS.map(field => field.key), ["daily_grant", "hold_max", "visitor_daily"]);
  assert.deepEqual(readAmounts({ daily_grant: "50", hold_max: " 100 ", visitor_daily: "0" }, settings), { daily_grant: 50, hold_max: 100, visitor_daily: 0 });
  assert.deepEqual(readAmounts({ daily_grant: "-1", hold_max: "100", visitor_daily: "0" }, settings), { invalid: "daily_grant" });
  assert.deepEqual(readAmounts({ daily_grant: "5", hold_max: "0", visitor_daily: "0" }, settings), { invalid: "hold_max" });
  assert.deepEqual(readAmounts({ daily_grant: "5", hold_max: "10", visitor_daily: "1.5" }, settings), { invalid: "visitor_daily" });
  assert.deepEqual(readAmounts({ daily_grant: "", hold_max: "10", visitor_daily: "1" }, settings), { invalid: "daily_grant" });
});

test("the summary says what everyone gets and what each price costs", () => {
  assert.match(creditSummary({ daily_grant: 50, hold_max: 100, visitor_daily: 10 }), /^Un compte reçoit 50 crédits par jour et en garde 100 au plus ; un visiteur sans compte a 10 crédits par jour\./);
  assert.match(creditSummary({ daily_grant: 1, hold_max: 1, visitor_daily: 0 }), /1 crédit par jour.*il faut un compte pour voir les prix/);
});

test("saving sends the revision and a conflict is explained", async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = [url, init]; return { ok: true, status: 200, json: async () => settings }; };
  await saveCreditSettings({ daily_grant: 20, hold_max: 30, visitor_daily: 0 }, 3);
  assert.equal(seen[0], "/api/v2/credits/settings");
  assert.equal(seen[1].method, "PUT");
  assert.deepEqual(JSON.parse(seen[1].body), { daily_grant: 20, hold_max: 30, visitor_daily: 0, expected_revision: 3 });
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({}) });
  await assert.rejects(saveCreditSettings({ daily_grant: 20, hold_max: 30, visitor_daily: 0 }, 3), /modifiés entre-temps/);
});
