import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-availability.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { dayLabel, loadRecheckSettings, loadWithdrawn, lookAgain, recheckSummary, saveRecheckSettings, withdrawnAt, withdrawnPricesText, withdrawnText }
  = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const entry = { store_id: 4, store_name: "Auchan Houilles", city: "Houilles", retailer: "Auchan", sales_channel: "drive",
  since: "2026-10-02", checked: "2026-11-01", next_check: "2026-12-01" };
const answer = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("a withdrawal is found by store and sales channel, not by store alone", () => {
  assert.equal(withdrawnAt([entry], 4, "drive"), entry);
  assert.equal(withdrawnAt([entry], 4, "in_store"), undefined);
  assert.equal(withdrawnAt([entry], 5, "drive"), undefined);
});

test("dates are written day first without a time zone shift", () => {
  assert.equal(dayLabel("2026-11-01"), "01/11/2026");
  assert.equal(dayLabel("n/a"), "n/a");
});

test("the notice says since when and when the next check is, or that there is none", () => {
  assert.equal(withdrawnText(entry), "Retiré de la gamme depuis le 02/10/2026 · nouvelle vérification à partir du 01/12/2026");
  assert.equal(withdrawnText({ ...entry, next_check: null }),
    "Retiré de la gamme depuis le 02/10/2026 · pas de nouvelle vérification automatique");
});

test("the delay is worded in the singular, the plural and for never", () => {
  assert.match(recheckSummary(1), /après 1 jour,/);
  assert.match(recheckSummary(30), /après 30 jours,/);
  assert.match(recheckSummary(0), /jamais relu automatiquement/);
  assert.match(withdrawnPricesText(1), /^1 prix ignoré :/);
  assert.match(withdrawnPricesText(3), /^3 prix ignorés :/);
});

test("the list for a product is read from the public route, and a failure shows no notice", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init.method]); return answer(200, { stores: [entry], truncated: false })(); };
  assert.deepEqual(await loadWithdrawn(12), { stores: [entry], truncated: false });
  assert.deepEqual(calls, [["/api/v2/availability/products/12", "GET"]]);
  globalThis.fetch = answer(500, { detail: "boom" });
  assert.deepEqual(await loadWithdrawn(12), { stores: [], truncated: false });
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.deepEqual(await loadWithdrawn(12), { stores: [], truncated: false });
});

test("an administrator asks for a new check of one store and channel", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init.method]); return answer(200, { stores: [], truncated: false })(); };
  await lookAgain(12, 4, "drive");
  assert.deepEqual(calls, [["/api/v2/availability/products/12/stores/4?channel=drive", "DELETE"]]);
  globalThis.fetch = answer(403, { detail: "Accès administrateur requis." });
  await assert.rejects(lookAgain(12, 4, "drive"), /Accès administrateur requis\./);
});

test("the delay setting is read and saved with the revision it was read at", async () => {
  const calls = [];
  const settings = { recheck_days: 30, revision: 2, min: 0, max: 365 };
  globalThis.fetch = async (url, init) => { calls.push([url, init.method, init.body]); return answer(200, settings)(); };
  assert.deepEqual(await loadRecheckSettings(), settings);
  await saveRecheckSettings(45, 2);
  assert.deepEqual(calls[1], ["/api/v2/availability/settings", "PUT", JSON.stringify({ recheck_days: 45, expected_revision: 2 })]);
  globalThis.fetch = answer(409, { detail: "Réglage modifié entre-temps. Rechargez la page." });
  await assert.rejects(saveRecheckSettings(45, 1), /modifié entre-temps/);
  globalThis.fetch = answer(500, null);
  await assert.rejects(saveRecheckSettings(45, 1), /L’opération n’a pas abouti\./);
});
