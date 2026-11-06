import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-setup-api.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { SetupNetworkError, setupRequest } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const answer = (status, body) => ({ status, ok: status >= 200 && status < 300,
  json: async () => { if (body === undefined) throw new SyntaxError("Unexpected token '<'"); return body; } });
let calls = [];
const serve = response => { calls = []; globalThis.fetch = async (url, init) => { calls.push([url, init]); return response; }; };

test("a setup call sends the same request as before, and reads its JSON", async () => {
  serve(answer(201, { configured: true }));
  const payload = { provider: "postgres", host: "db", public_hostname: undefined, access_code: "code" };
  assert.deepEqual(await setupRequest("database", "POST", payload), { configured: true });
  assert.deepEqual(calls, [["/api/v2/setup/database", { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: '{"provider":"postgres","host":"db","access_code":"code"}' }]]);
  serve(answer(200, { configured: false, app_env: "dev" }));
  assert.deepEqual(await setupRequest("status"), { configured: false, app_env: "dev" });
  assert.deepEqual(calls[0], ["/api/v2/setup/status", { method: "GET", credentials: "same-origin", headers: undefined, body: undefined }]);
});

test("a refusal shows the server's text, every validation message, or the status line", async () => {
  serve(answer(403, { detail: "Code administrateur incorrect." }));
  await assert.rejects(setupRequest("database/details", "POST", { access_code: "x" }), { message: "Code administrateur incorrect." });
  serve(answer(422, { detail: [{ msg: "Field required" }, { msg: "Input should be a valid integer" }] }));
  await assert.rejects(setupRequest("database/test", "POST", {}), { message: "Field required; Input should be a valid integer" });
  serve(answer(502));
  await assert.rejects(setupRequest("status"), error => !(error instanceof SetupNetworkError) && error.message === "Request failed with status code 502");
});

test("no answer at all is a network error, which the gateway reads as offline", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(setupRequest("status"), error => error instanceof SetupNetworkError && error.message === "Network Error");
});
