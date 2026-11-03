import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-saved-lists.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { applyListOps, defaultListName, lineCount, listsKey, listsQueueKey, newListId, queueListOp, readLists, validListId, writeLists, writeListsQueue } =
  await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));

const content = { source: "basket", sections: [{ retailer: "Leclerc", store: "Drive", cents: 335, lines: [{ key: "product:1", label: "Lait" }, { key: "group:riz", label: "Riz", missing: true }] }] };
const list = (id, name, updated_at = "2026-11-03T08:00:00.000Z") => ({ id, name, content, checked: [], created_at: updated_at, updated_at });
const A = "0b7a1c2e-4d5f-4a6b-8c7d-9e0f1a2b3c4d", B = "1c8b2d3f-5e6a-4b7c-9d8e-0f1a2b3c4d5e";

test("list ids are chosen here, so a list saved offline is stored once", () => {
  const id = newListId();
  assert.ok(validListId(id), id);
  assert.notEqual(newListId(), id);
  for (const bad of ["", "x", "0b7a1c2e-4d5f-4a6b-8c7d", "0b7a1c2e-4d5f-0a6b-8c7d-9e0f1a2b3c4d"]) assert.equal(validListId(bad), false, bad);
});

test("queued changes to one list join; a deletion replaces what came before", () => {
  let queue = queueListOp([], { op: "put", list: list(A, "Samedi") });
  queue = queueListOp(queue, { op: "patch", id: A, checked: ["product:1"] });
  queue = queueListOp(queue, { op: "patch", id: A, name: "Samedi matin" });
  assert.deepEqual(queue, [{ op: "put", list: { ...list(A, "Samedi matin"), checked: ["product:1"] } }], "one request for a list saved and ticked offline");
  queue = queueListOp(queue, { op: "patch", id: B, checked: ["group:riz"] });
  queue = queueListOp(queue, { op: "patch", id: B, name: "Autre" });
  assert.deepEqual(queue[1], { op: "patch", id: B, checked: ["group:riz"], name: "Autre" });
  queue = queueListOp(queue, { op: "delete", id: A });
  assert.deepEqual(queue.map(op => op.op), ["patch", "delete"]);
});

test("the lists shown: the server's, with the waiting changes, the most recent first", () => {
  const server = [list(A, "Samedi", "2026-11-01T08:00:00.000Z")];
  const shown = applyListOps(server, [{ op: "put", list: list(B, "Dimanche", "2026-11-03T08:00:00.000Z") }, { op: "patch", id: A, checked: ["product:1"] }]);
  assert.deepEqual(shown.map(item => [item.name, item.checked]), [["Dimanche", []], ["Samedi", ["product:1"]]]);
  assert.deepEqual(applyListOps(server, [{ op: "delete", id: A }]), []);
  assert.equal(lineCount(server[0]), 2);
});

test("lists and waiting changes are kept in this browser, per account", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); }, removeItem: key => { store.delete(key); } };
  writeLists(5, [list(A, "Samedi")]);
  writeListsQueue(5, [{ op: "delete", id: B }, { op: "patch", id: "not-an-id" }]);
  const kept = readLists(5);
  assert.deepEqual(kept.lists.map(item => item.id), [A]);
  assert.deepEqual(kept.queue, [{ op: "delete", id: B }], "an unusable change is dropped");
  assert.deepEqual(readLists(6), { lists: [], queue: [] });
  assert.deepEqual(readLists(null), { lists: [], queue: [] });
  assert.ok([listsKey(5), listsQueueKey(5)].every(key => key.startsWith("v2:basket:") && key.endsWith(":5")), "removed with the account's local data");
  writeListsQueue(5, []);
  assert.equal(store.has(listsQueueKey(5)), false);
  store.set(listsKey(5), "{oops");
  assert.deepEqual(readLists(5).lists, []);
  delete globalThis.localStorage;
});

test("a new list is named after the day, or the store", () => {
  const date = new Date("2026-11-07T10:00:00");
  assert.match(defaultListName(date), /^Courses du 7 nov/);
  assert.match(defaultListName(date, "Auchan"), /^Auchan · 7 nov/);
});
