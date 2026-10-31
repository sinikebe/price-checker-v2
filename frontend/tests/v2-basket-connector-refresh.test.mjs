import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-connector-refresh.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

let instance = 0;
// The module keeps request history and the connector list in memory: give each test its own copy.
const load = () => import("data:text/javascript;base64," + Buffer.from(`${output}\n// ${instance++}`).toString("base64"));

function network({ connectors = ["auchan"], refuse = () => false, online = true } = {}) {
  const posts = [];
  Object.defineProperty(globalThis, "navigator", { value: { onLine: online }, configurable: true });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/connector-stores/versions")) {
      return new Response(JSON.stringify({ connectors: connectors.map(id => ({ id, enabled: true })) }));
    }
    const connector = String(url).split("/connector-stores/")[1].split("/")[0];
    const ids = JSON.parse(init.body).product_ids;
    const status = refuse(connector, posts.length) ? 429 : 200;
    posts.push({ connector, ids, status });
    return new Response("{}", { status });
  };
  return posts;
}

const product = id => ({ id, data: {}, revision: 1 });

test("only products new to the basket are requested, in basket order, ignoring groups and scopes", async () => {
  const { addedProductIds } = await load();
  const next = [product(7), { kind: "group", name: "Lait" }, product(1), { kind: "scope", name: "Épicerie" }, product(9)];
  assert.deepEqual(addedProductIds(new Set([1, 2]), next), [7, 9]);
  assert.deepEqual(addedProductIds(new Set([1, 7, 9]), next), []);
  assert.deepEqual(addedProductIds(new Set(), []), []);
});

test("products added together make one request, not one each", async () => {
  const posts = network();
  const { addedProductIds, requestBasketConnectorRefresh } = await load();
  const added = addedProductIds(new Set(), Array.from({ length: 10 }, (_, index) => product(100 + index)));
  await requestBasketConnectorRefresh(added);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].ids, added);
});

test("a batch above fifty products is split in requests of fifty", async () => {
  const posts = network();
  const { requestBasketConnectorRefresh } = await load();
  await requestBasketConnectorRefresh(Array.from({ length: 120 }, (_, index) => 1 + index));
  assert.deepEqual(posts.map(post => post.ids.length), [50, 50, 20]);
});

test("a refusal stops the remaining requests of that connector only", async () => {
  const posts = network({ connectors: ["auchan", "chronodrive"], refuse: connector => connector === "auchan" });
  const { requestBasketConnectorRefresh } = await load();
  await requestBasketConnectorRefresh(Array.from({ length: 120 }, (_, index) => 1 + index));
  assert.deepEqual(posts.map(post => [post.connector, post.ids.length, post.status]), [
    ["auchan", 50, 429], ["chronodrive", 50, 200], ["chronodrive", 50, 200], ["chronodrive", 20, 200],
  ]);
});

test("the same products are not requested again within a minute, and nothing is sent offline", async () => {
  const posts = network();
  const { requestBasketConnectorRefresh } = await load();
  await requestBasketConnectorRefresh([1, 2, 2]);
  await requestBasketConnectorRefresh([2, 3]);
  assert.deepEqual(posts.map(post => post.ids), [[1, 2], [3]]);
  const offline = network({ online: false });
  await requestBasketConnectorRefresh([4, 5]);
  assert.equal(offline.length, 0);
});
