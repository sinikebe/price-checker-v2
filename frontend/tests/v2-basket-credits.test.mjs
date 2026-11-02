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

const credits = { balance: 0, daily_grant: 50, hold_max: 100, next_grant_on: "2026-11-03", unlimited: false, visitor: false };
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
  globalThis.fetch = answer(429, { detail: { code: "no_credits", credits, cost: 1 } });
  await assert.rejects(fetchBasketPrices(item), error => error instanceof NoCreditsError && error.credits.next_grant_on === "2026-11-03" && error.cost === 1);
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

test("an administrator is never out of credits, and is not shown a cost", async () => {
  const { outOfCredits, costNote } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const member = { ...credits, balance: 0 };
  assert.equal(outOfCredits(member), true);
  assert.equal(outOfCredits({ ...member, balance: 3 }), false);
  assert.equal(outOfCredits({ ...member, unlimited: true }), false, "the balance is only a placeholder for an administrator");
  assert.equal(outOfCredits(null), false, "an unknown balance leaves the decision to the server");
  assert.equal(costNote(member), " (1 crédit)");
  assert.equal(costNote({ ...member, unlimited: true }), "");
  assert.equal(costNote(null), " (1 crédit)");
});

test("costs follow the number of credits asked", async () => {
  const { outOfCredits, costNote } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const member = { ...credits, balance: 3 };
  assert.equal(outOfCredits(member, 3), false);
  assert.equal(outOfCredits(member, 4), true, "a basket of 4 lines needs 4 credits");
  assert.equal(costNote(member, 12), " (12 crédits)");
  assert.equal(costNote({ ...member, unlimited: true }, 12), "");
});

test("balances and shortfalls are said in plain words, for accounts and visitors", async () => {
  const { balanceText, shortText } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const plain = text => text.replace(/[\u202f\u00a0]/g, " ");
  assert.equal(balanceText({ ...credits, balance: 12 }), "12 crédits restants");
  assert.equal(balanceText({ ...credits, balance: 1 }), "1 crédit restant");
  assert.equal(balanceText({ ...credits, unlimited: true }), "Sans limite pour un administrateur");
  assert.equal(balanceText({ ...credits, balance: 2, daily_grant: 10, hold_max: 10, visitor: true }), "2 crédits restants aujourd’hui sans compte");
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const next = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  assert.equal(plain(shortText({ ...credits, balance: 2, next_grant_on: next }, 5)),
    "Il faut 5 crédits, il vous en reste 2. Les prochains arrivent demain (50 par jour, 100 au maximum).");
  assert.match(shortText({ ...credits, balance: 0, daily_grant: 10, hold_max: 10, visitor: true, next_grant_on: next }, 1), /Connectez-vous pour avoir des crédits chaque jour/);
  assert.equal(shortText({ ...credits, balance: 0, daily_grant: 0, hold_max: 0, visitor: true }, 1), "Connectez-vous pour voir les prix.");
});

test("a paid request says why nothing was shown, and never hides an unexpected answer", async () => {
  const { paidFetch, readCredits, NoCreditsError: Short, CostChangedError } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  let seen;
  globalThis.fetch = async (url, init) => { seen = [url, init]; return answer(200, { observations: [1], credits: { ...credits, balance: 9 } })(); };
  const paid = await paidFetch("/api/v2/prices/products/3");
  assert.deepEqual([paid.observations, paid.credits.balance], [[1], 9]);
  assert.equal(seen[1].cache, "no-store");
  assert.equal(seen[1].credentials, "same-origin");
  assert.equal(seen[1].method, undefined, "a GET: read-only tokens can call it too");
  globalThis.fetch = answer(429, { detail: { code: "no_credits", credits, cost: 4, message: "Pas assez de crédits pour afficher ces prix." } });
  await assert.rejects(paidFetch("/x"), error => error instanceof Short && error.cost === 4);
  globalThis.fetch = answer(409, { detail: { code: "cost_changed", cost: 7 } });
  await assert.rejects(paidFetch("/x"), error => error instanceof CostChangedError && error.cost === 7);
  globalThis.fetch = answer(429, { detail: "Trop" });
  await assert.rejects(paidFetch("/x"), /Trop de requêtes/);
  globalThis.fetch = answer(404, {});
  await assert.rejects(paidFetch("/x"), /Introuvable/);
  globalThis.fetch = answer(500, {});
  await assert.rejects(paidFetch("/x"), /Aucun crédit n’a été dépensé/);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(paidFetch("/x"), /Vérifiez votre solde/);
  globalThis.fetch = async (url) => { seen = url; return answer(200, { ...credits, visitor: true })(); };
  assert.equal((await readCredits()).visitor, true);
  assert.equal(seen, "/api/v2/credits");
});
