import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-server-cache-api.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { formatBytes, diskPercent, diskLevel, lastRunSummary, getServerCache, requestCacheClean }
  = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const nbsp = text => text.replace(/[  ]/g, " ");

test("sizes use decimal units like the disk tools and Docker", () => {
  assert.equal(formatBytes(0), "0 o");
  assert.equal(formatBytes(999), "999 o");
  assert.equal(formatBytes(24_207_262), "24,2 Mo");
  assert.equal(nbsp(formatBytes(1_826_000_000)), "1,8 Go");
  assert.equal(nbsp(formatBytes(35_050_504_192)), "35,1 Go");
  assert.equal(formatBytes(621_800), "622 ko");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("the disk bar follows the 80 % alert threshold of the host", () => {
  assert.equal(diskPercent({ total_bytes: 100, used_bytes: 57, available_bytes: 43 }), 57);
  assert.equal(diskPercent({ total_bytes: 0, used_bytes: 5, available_bytes: 0 }), 0);
  assert.equal(diskPercent({ total_bytes: 100, used_bytes: 130, available_bytes: 0 }), 100);
  assert.deepEqual([79, 80, 81, 90, 91].map(diskLevel), ["ok", "ok", "warning", "warning", "high"]);
});

test("the last cleaning says when, by what, and what it freed or why it failed", () => {
  const when = () => "1 nov., 14:03";
  assert.equal(nbsp(lastRunSummary({ at: "x", result: "done", trigger: "manual", freed_bytes: 1_970_000_000 }, when)),
    "Dernier nettoyage 1 nov., 14:03 (demandé depuis cette page) : 2 Go libérés.");
  assert.equal(lastRunSummary({ at: "x", result: "done", trigger: "update" }, when),
    "Dernier nettoyage 1 nov., 14:03 (après une mise à jour) : terminé.");
  assert.equal(lastRunSummary({ at: "x", result: "failed", trigger: "manual", message: "docker is down" }, when),
    "Dernier nettoyage 1 nov., 14:03 (demandé depuis cette page) : échec — docker is down.");
  assert.equal(lastRunSummary({ at: "x", result: "running", trigger: "manual" }, when), "Nettoyage commencé 1 nov., 14:03.");
});

test("reading and requesting go to the right routes, without cache, and surface the server's reason", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init.method, init.cache, init.credentials]); return { ok: true, json: async () => ({ state: null }) }; };
  await getServerCache(); await requestCacheClean();
  assert.deepEqual(calls, [["/api/v2/server-cache", "GET", "no-store", "same-origin"], ["/api/v2/server-cache/clean", "POST", "no-store", "same-origin"]]);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ detail: "Un nettoyage est déjà demandé." }) });
  await assert.rejects(requestCacheClean(), /déjà demandé/);
  globalThis.fetch = async () => ({ ok: false, json: async () => { throw new Error("not json"); } });
  await assert.rejects(getServerCache(), /n’a pas pu être chargé/);
});
