import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-connector-queue-state.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isActiveStatus, readingFinished } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("only queued and running readings are active", () => {
  assert.equal(isActiveStatus("queued"), true);
  assert.equal(isActiveStatus("running"), true);
  for (const status of ["eligible", "rate_limited", "unavailable", "disabled", "unsupported", ""])
    assert.equal(isActiveStatus(status), false);
});

test("a reading is finished once an active product leaves the queue with a real outcome", () => {
  assert.equal(readingFinished("queued", "fresh"), true);
  assert.equal(readingFinished("running", "eligible"), true);
});

test("still waiting, never seen or throttled answers are not a finished reading", () => {
  assert.equal(readingFinished("queued", "running"), false);
  assert.equal(readingFinished("running", "queued"), false);
  assert.equal(readingFinished(undefined, "fresh"), false);
  assert.equal(readingFinished("eligible", "fresh"), false);
  for (const status of ["rate_limited", "unavailable", "disabled"])
    assert.equal(readingFinished("queued", status), false);
});
