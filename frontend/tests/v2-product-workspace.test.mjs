import assert from "node:assert/strict";
import { test } from "node:test";
import { Fragment, fire, h, loadModule, render, settle, startDom } from "./fixtures/react-harness.mjs";

startDom();
const http = await loadModule("v2-http.ts");
const productsApi = await loadModule("v2-products-api.ts", {
  "../pwa/cache-writes": { cacheApprovedProduct: async () => {} },
  "./v2-product-errors": await loadModule("v2-product-errors.ts", { "./v2-http": http }),
  "./v2-http": http,
});

// What the page is given: the requests it makes, the app mode, and an Open Food Facts read.
const requests = [];
let answer = () => { throw new Error("no answer"); };
let appMode = "shop";
const offProduct = { code: "3017620422003", name: "Nutella", brand: "Ferrero", quantity: "400 g", image: null,
  nutriscore: "", nova: "", ingredients: "", modifiedAt: null, nutrition: [] };
const offRead = { phase: "done", product: offProduct };
const navigations = [];
const navigate = path => { navigations.push(path); };
const nothing = () => null;
const component = { default: nothing };
const { default: V2ProductWorkspace } = await loadModule("V2ProductWorkspace.tsx", {
  "./V2Info": { default: () => null },
  "react-router-dom": {
    Link: ({ to, className, children }) => h("a", { href: to, className }, children),
    Navigate: nothing, useLocation: () => ({ search: "" }), useNavigate: () => navigate,
  },
  "./useConfirm": { useConfirm: () => async () => true },
  "./V2SiteHeader": { V2PageFrame: ({ children }) => h(Fragment, null, children) },
  "./V2OffLookup": component, "./V2PriceHistory": component,
  "./V2OffPanel": { default: nothing, OffDetails: nothing },
  "./useOffProduct": { useOffProduct: code => code ? offRead : { phase: "idle" } },
  "./V2ExtensionPriceButton": component, "./V2PriceDraftInbox": component, "./V2ReportControl": component,
  "./V2ModerationPanel": component, "./V2RecipeReviewPanel": component, "./V2BasketAddButtons": component,
  "./V2ShoppingPrice": component, "./V2ShareButton": component,
  "./useAppMode": { useAppMode: () => ({ mode: appMode }) },
  "./v2-products-api": { ...productsApi, productRequest: async (path, method = "GET", body) => { requests.push({ path, method, body }); return answer(path, method); } },
  "./v2-measures": await loadModule("v2-measures.ts"),
  "./v2-basket-credits-api": await loadModule("v2-basket-credits-api.ts"),
  "./useCredits": { useCredits: () => null },
  "./v2-http": http,
  "./v2-catalogue-search": await loadModule("v2-catalogue-search.ts"),
  "./v2-basket-view": { euros: value => value + " €" },
  "./v2-off-browser": await loadModule("v2-off-browser.ts"),
});
const user = { id: 7, email: "a@example.test", role: "user" };
const page = props => h(V2ProductWorkspace, { user, onLogout: async () => {}, ...props });
const alerts = () => [...document.querySelectorAll("[role=alert]")].map(item => item.textContent);

function memoryStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  return { store, getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
}
// Site data blocked (all cookies blocked in Chrome): even reading `localStorage` throws.
function blockStorage() {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("The operation is insecure."); } });
}
const useStorage = storage => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

test("a barcode-only product page scrolls to the top when it opens, not on each later render", async () => {
  let scrolls = 0;
  window.scrollTo = () => { scrolls += 1; };
  appMode = "shop";
  answer = path => ({ id: Number(path.slice(1)), revision: 1, predecessor_id: null, updated_at: "2026-11-01", off_reference: true,
    data: { ...productsApi.emptyProduct(), ean: offProduct.code } });
  const view = await render(page({ mode: "detail", id: 1 }));
  await settle();
  assert.match(document.querySelector("h1").textContent, /Nutella/, "the name read at Open Food Facts is shown");
  assert.equal(scrolls, 1);
  // Adding it to the basket, a shared basket update or another tab re-renders the page.
  await view.update(page({ mode: "detail", id: 1 }));
  await view.update(page({ mode: "detail", id: 1 }));
  assert.equal(scrolls, 1, "the reader's scroll position stays");
  await view.update(page({ mode: "detail", id: 2 }));
  await settle();
  assert.equal(scrolls, 2, "another product opens at the top");
  await view.unmount();
});

test("the editor restores its local copy, and forgets it once the server has the draft", async () => {
  const storage = memoryStorage({ "v2:product:new:7": JSON.stringify({ data: { name: "Brouillon local" }, change_kind: "correction", revision: null }) });
  useStorage(storage);
  requests.length = 0; navigations.length = 0;
  answer = (path, method) => path === "/drafts" && method === "POST" ? { id: 42 } : null;
  const view = await render(page({ mode: "new" }));
  const name = [...document.querySelectorAll("label")].find(label => label.querySelector("span")?.textContent === "Nom du produit").querySelector("input");
  assert.equal(name.value, "Brouillon local");
  await fire(document.querySelector("form"), "submit");
  await settle();
  assert.equal(requests.at(-1).body.data.name, "Brouillon local");
  assert.deepEqual(navigations, ["/v2/brouillons/42"]);
  assert.equal(storage.store.has("v2:product:new:7"), false);
  await view.unmount();
});

test("with site data blocked, a saved draft still opens and no storage error is shown", async () => {
  blockStorage();
  requests.length = 0; navigations.length = 0;
  answer = (path, method) => path === "/drafts" && method === "POST" ? { id: 43 } : null;
  const view = await render(page({ mode: "new" }));
  await fire(document.querySelector("form"), "submit");
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(navigations, ["/v2/brouillons/43"]);
  assert.deepEqual(alerts(), []);
  await view.unmount();
  useStorage(memoryStorage());
});
