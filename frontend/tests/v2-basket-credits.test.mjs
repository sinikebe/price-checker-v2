import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-basket-credits-api.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { NoCreditsError, SignedOutError, creditLabel, fetchBasketPrices, nextGrantLabel, readBasketCredits, wireItems }
  = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const credits = { balance: 0, daily_grant: 5, weekly_max: 20, hold_max: 20, granted_this_week: 5, next_grant_on: "2026-11-03" };
const answer = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("the request names each article by what the server needs", () => {
  const product = { id: 7, revision: 2, data: { name: "Lait" }, quantity: { amount: "2", unit: "l" }, disabled: true };
  assert.deepEqual(wireItems([product, { kind: "group", name: "Lait", quantity: { amount: "1", unit: "package" } },
    { kind: "scope", department: "Frais", family: "Laitiers", name: "Lait" }]), [
    { kind: "product", id: 7 }, { kind: "group", name: "Lait" },
    { kind: "scope", department: "Frais", family: "Laitiers", name: "Lait" }]);
});

test("one POST carries the whole basket", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return answer(200, { lines: [] })(); };
  await fetchBasketPrices([{ id: 3, revision: 1, data: { name: "Riz" } }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/v2/basket/prices");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0][1].body), { items: [{ kind: "product", id: 3 }] });
});

test("each failure says what happened to the credit", async () => {
  const item = [{ id: 3, revision: 1, data: { name: "Riz" } }];
  globalThis.fetch = answer(401, {});
  await assert.rejects(fetchBasketPrices(item), SignedOutError);
  globalThis.fetch = answer(429, { detail: { code: "no_credits", credits } });
  await assert.rejects(fetchBasketPrices(item), error => error instanceof NoCreditsError && error.credits.next_grant_on === "2026-11-03");
  globalThis.fetch = answer(429, { detail: "Trop de requêtes." });
  await assert.rejects(fetchBasketPrices(item), error => !(error instanceof NoCreditsError) && /Trop de requêtes/.test(error.message));
  globalThis.fetch = answer(500, {});
  await assert.rejects(fetchBasketPrices(item), /Aucun crédit n’a été dépensé/);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchBasketPrices(item), /Vérifiez votre solde/);
});

test("the balance is read without cache and a lost session is told apart", async () => {
  let options;
  globalThis.fetch = async (_url, init) => { options = init; return answer(200, credits)(); };
  assert.deepEqual(await readBasketCredits(), credits);
  assert.equal(options.cache, "no-store");
  globalThis.fetch = answer(401, {});
  await assert.rejects(readBasketCredits(), SignedOutError);
});

test("the next grant is named in everyday words", () => {
  const sunday = new Date(2026, 10, 1, 15, 0);
  assert.equal(nextGrantLabel("2026-11-02", sunday), "demain");
  assert.equal(nextGrantLabel("2026-11-01", sunday), "demain");
  assert.equal(nextGrantLabel("2026-11-05", sunday), "jeudi");
  assert.equal(nextGrantLabel("2026-11-09", new Date(2026, 10, 5, 8, 0)), "lundi");
  assert.equal(creditLabel(0), "0 crédit");
  assert.equal(creditLabel(1), "1 crédit");
  assert.equal(creditLabel(5), "5 crédits");
});
