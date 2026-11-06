import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-calendar-day.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readingTime } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
const shown = time => new Date(time).toLocaleDateString("fr-FR");

for (const zone of ["America/New_York", "Europe/Paris", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  test(`a reading day shows as that same day in ${zone}`, () => {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
      // The category chart used Date.parse, which reads a bare day as UTC midnight: 31/10 west of UTC.
      assert.equal(shown(readingTime("2026-11-01")), "01/11/2026");
      assert.ok(readingTime("2026-11-01") < readingTime("2026-11-02"));
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });
}

test("a full timestamp is read as it is, and a malformed value stays unreadable", () => {
  assert.equal(readingTime("2026-11-01T08:30:00Z"), Date.parse("2026-11-01T08:30:00Z"));
  assert.ok(Number.isNaN(readingTime("hier")));
});
