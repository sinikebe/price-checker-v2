import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-http.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { ApiError, apiError, apiErrorText, errorDetail, errorText, requestJson }
  = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

/** A fetch answer: `body` is the JSON, or a function standing for an unreadable body. */
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300,
  json: async () => { if (typeof body === "function") return body(); return body; } });
const notJson = () => { throw new SyntaxError("Unexpected token '<'"); };
let calls = [];
const serve = (...answers) => { calls = []; globalThis.fetch = async (url, init) => { calls.push([url, init]); return answers.shift(); }; };
const fallback = "Opération impossible.";

test("a FastAPI detail is shown as it is, and a French rule of the server without its prefix", () => {
  assert.equal(apiErrorText("Nom de groupe nécessaire.", fallback), "Nom de groupe nécessaire.");
  assert.equal(apiErrorText([{ type: "value_error", loc: ["body", "name"], msg: "Value error, Nom de groupe nécessaire." }], fallback), "Nom de groupe nécessaire.");
  assert.equal(apiErrorText([{ type: "string_too_short", msg: "x" }, { type: "value_error", msg: "Value error, Ville et code postal nécessaires." }], fallback),
    "Ville et code postal nécessaires.", "the first rule of the server, wherever it is in the list");
});

test("a validation list or an object never shows as [object Object]", () => {
  assert.equal(apiErrorText([{ type: "greater_than", msg: "Input should be greater than 0" }], fallback), fallback);
  assert.equal(apiErrorText([{ type: "value_error", msg: "Value error, " }], fallback), fallback);
  for (const detail of [null, undefined, 3, {}, { code: "x" }, [], [null], [{ type: "value_error", msg: 4 }]]) assert.equal(apiErrorText(detail, fallback), fallback);
  assert.ok(apiErrorText([{ type: "value_error", msg: "x".repeat(1000) }], fallback).length <= 300);
});

test("the detail of a refused response, and the error to throw for it", async () => {
  assert.deepEqual(await errorDetail(answer(422, { detail: [{ msg: "m" }] })), [{ msg: "m" }]);
  assert.equal(await errorDetail(answer(502, notJson)), null);
  assert.equal(await errorDetail(answer(400, { message: "no detail" })), null);
  const error = await apiError(answer(502, notJson), "Les documents légaux ne répondent pas. Réessayez.");
  assert.ok(error instanceof ApiError && error instanceof Error);
  assert.equal(error.message, "Les documents légaux ne répondent pas. Réessayez.");
  assert.equal(error.status, 502);
});

test("a request throws the server's reason with its status, or the caller's fallback", async () => {
  serve(answer(409, { detail: "La planification a changé. Rechargez-la avant d’enregistrer." }));
  await assert.rejects(requestJson("/api/v2/updates/schedule", { method: "PUT", body: { time: "02:00" }, fallback }),
    error => error instanceof ApiError && error.status === 409 && error.message === "La planification a changé. Rechargez-la avant d’enregistrer.");
  serve(answer(422, { detail: [{ type: "missing", loc: ["body", "name"], msg: "Field required" }] }));
  await assert.rejects(requestJson("/x", { fallback }), error => error.message === fallback && error.status === 422);
  serve(answer(422, { detail: { code: "no_credits" } }));
  await assert.rejects(requestJson("/x", { fallback }), error => error.message === fallback);
  serve(answer(502, notJson));
  await assert.rejects(requestJson("/x", { fallback }), error => error.message === fallback && error.status === 502);
});

test("a request reads JSON, and nothing from a 204", async () => {
  serve(answer(200, { stores: [1] }));
  assert.deepEqual(await requestJson("/x", { fallback }), { stores: [1] });
  serve(answer(204, notJson));
  assert.equal(await requestJson("/api/v2/account", { method: "DELETE", body: { password: "p" }, fallback }), undefined);
});

test("a request sends the session cookie, a JSON body only when given, and a cache mode only when asked", async () => {
  serve(answer(200, {}), answer(200, {}));
  await requestJson("/api/v2/auth/status", { fallback });
  await requestJson("/api/v2/stores/7/delete", { method: "POST", body: { confirmation: "x" }, cache: "no-store", fallback });
  const [[firstUrl, first], [secondUrl, second]] = calls;
  assert.equal(firstUrl, "/api/v2/auth/status");
  assert.deepEqual(first, { method: "GET", credentials: "same-origin", headers: undefined, body: undefined });
  assert.equal("cache" in first, false, "the browser's default cache, as authRequest always had");
  assert.equal(secondUrl, "/api/v2/stores/7/delete");
  assert.deepEqual(second, { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "x" }) });
});

test("a network failure keeps fetch's own TypeError, which the gateway reads as offline", async () => {
  const failure = new TypeError("Failed to fetch");
  globalThis.fetch = async () => { throw failure; };
  await assert.rejects(requestJson("/api/v2/auth/status", { fallback }), error => error === failure);
});

test("a caught error shows its own message, never 'Error:' or an English network failure", () => {
  assert.equal(errorText(new Error("Vous avez déjà signalé ce contenu."), fallback), "Vous avez déjà signalé ce contenu.");
  assert.equal(errorText(new ApiError("Produit introuvable.", 404), fallback), "Produit introuvable.");
  assert.equal(errorText(new TypeError("Failed to fetch"), fallback), fallback);
  assert.equal(errorText(new Error(""), fallback), fallback);
  assert.equal(errorText("Error: texte", fallback), fallback);
  assert.equal(errorText(undefined, "L’export n’a pas pu être préparé."), "L’export n’a pas pu être préparé.");
});
