import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-credit-rewards.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { creditRewards, rewardLine } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

test("each reward says what was earned, for what, and when", () => {
  assert.match(rewardLine({ kind: "price", credits: 5, created_at: "2026-11-02T10:00:00Z" }), /^\+5 crédits · relevé de prix validé · 2 nov/);
  assert.match(rewardLine({ kind: "product", credits: 1, created_at: "2026-11-02T10:00:00Z" }), /^\+1 crédit · fiche produit validée/);
  assert.match(rewardLine({ kind: "recipe", credits: 10, created_at: "2026-11-02T10:00:00Z" }), /recette validée/);
});

test("the list is read for the signed-in account, without cache", async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = [url, init]; return { ok: true, json: async () => ({ rewards: [], earned_total: 0 }) }; };
  assert.deepEqual(await creditRewards(), { rewards: [], earned_total: 0 });
  assert.equal(seen[0], "/api/v2/credits/rewards");
  assert.equal(seen[1].cache, "no-store");
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(creditRewards(), /indisponibles/);
});
