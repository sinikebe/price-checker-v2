import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-site-nav.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { SEARCH_MAX_LENGTH, activeDockId, backTarget, basketLabel, dockItems, initials, normalizePath, parseV2Route, sharedBasketLabel, nextMenuIndex, profileMenuSections, roleLabel, searchPath, searchTermFromLocation } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const legalSource = readFileSync(new URL("../src/v2/v2-legal-documents.ts", import.meta.url), "utf8");
const { LEGAL_DOCUMENTS, plainLegalText } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(legalSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`);

test("shopping keeps the baskets and leaves the stores out; the contribution mode does the reverse", () => {
  assert.deepEqual(dockItems("shopping", false).map(item => item.id), ["home", "products", "recipes", "basket"]);
  assert.deepEqual(dockItems("contribute", false).map(item => item.id), ["home", "products", "stores", "recipes"]);
  assert.deepEqual(dockItems("contribute", true).map(item => item.id), ["home", "products", "stores", "recipes"]);
  for (const items of [dockItems("shopping", true), dockItems("contribute", false)])
    assert.equal(new Set(items.map(item => item.to)).size, items.length);
});

test("the shared basket gets its own dock entry once the account follows one", () => {
  assert.deepEqual(dockItems("shopping", true).map(item => item.id), ["home", "products", "recipes", "basket", "shared"]);
  assert.equal(dockItems("shopping", true).at(-1).to, "/v2/panier/partage");
  assert.equal(sharedBasketLabel(0), "Panier partagé, vide");
  assert.equal(sharedBasketLabel(3), "Panier partagé, 3 articles");
});

test("the dock holds five entries at most", () => {
  // A sixth entry would need the narrower phone styling of the dock back: it was dropped because the dock
  // has had five entries at most since the saved lists left it.
  for (const mode of ["shopping", "contribute"])
    for (const follows of [false, true]) assert.ok(dockItems(mode, follows).length <= 5, `${mode}, shared basket followed: ${follows}`);
});

test("every page maps to the right dock item", () => {
  const cases = [
    ["/", "home"], ["/v2", "home"], ["/v2/", "home"],
    ["/v2/produits", "products"], ["/v2/produits/12", "products"], ["/v2/produits/12/historique", "products"],
    ["/v2/categories/Lait", "products"], ["/v2/magasins", "stores"], ["/v2/magasins/7", "stores"],
    ["/v2/recettes", "recipes"], ["/v2/recettes/nouvelle", "recipes"], ["/v2/panier", "basket"],
    ["/v2/panier/partage", "shared"], ["/v2/panier/partage/", "shared"], ["/v2/panier/partage/liste", "shared"],
    ["/v2/panier/liste", "basket"],
  ];
  for (const [path, id] of cases) assert.equal(activeDockId(path), id, path);
});

test("pages reached from the profile menu highlight no dock item", () => {
  for (const path of ["/v2/produits/nouveau", "/v2/brouillons", "/v2/moderation", "/v2/a-completer", "/v2/capture",
    "/v2/capture/installer", "/v2/parametres", "/v2/parametres/securite", "/v2/connexion", "/v2/produitsx", "/v2/recettesx",
    "/v2/panier/demo", "/v2/panier/demo/liste"])
    assert.equal(activeDockId(path), null, path);
});

test("a signed-out visitor is offered to sign in and to open the settings, but no contribution or admin links", () => {
  for (const mode of ["shopping", "contribute"]) {
    const links = profileMenuSections(null, mode).flatMap(section => section.links.map(link => link.to));
    assert.deepEqual(links, ["/v2/connexion", "/v2/inscription", "/v2/parametres"]);
  }
});

test("shopping leaves the contribution links to the contribution mode", () => {
  const links = profileMenuSections({ username: "alice", role: "confirmed" }, "shopping").flatMap(section => section.links.map(link => link.to));
  assert.deepEqual(links, ["/v2/parametres"]);
  const admin = profileMenuSections({ username: "root", role: "admin" }, "shopping");
  assert.deepEqual(admin.map(section => section.id), ["me", "admin"]);
});

test("in the contribution mode, a member sees their drafts, the settings and the contribution links, and nothing administrative", () => {
  for (const role of ["confirmed", "visitor"]) {
    const sections = profileMenuSections({ username: "alice", role }, "contribute");
    const links = sections.flatMap(section => section.links.map(link => link.to));
    assert.ok(links.includes("/v2/brouillons") && links.includes("/v2/parametres"), role);
    assert.ok(!links.includes("/v2/connexion"), role);
    assert.ok(!sections.some(section => section.id === "admin"), role);
    assert.ok(!links.some(to => to.includes("moderation") || to.includes("/serveur") || to.includes("connecteurs")), role);
  }
});

test("an administrator also gets the administration links, pointing to existing settings tabs", () => {
  const sections = profileMenuSections({ username: "root", role: "admin" });
  const admin = sections.find(section => section.id === "admin");
  assert.deepEqual(admin.links.map(link => link.to), ["/v2/moderation", "/v2/parametres/connecteurs", "/v2/parametres/serveur"]);
  assert.equal(admin.heading, "Administration");
});

test("link ids are unique within the menu and the beta tag is on the capture link only", () => {
  const all = profileMenuSections({ username: "root", role: "admin" }, "contribute").flatMap(section => section.links);
  assert.equal(new Set(all.map(link => link.id)).size, all.length);
  assert.deepEqual(all.filter(link => link.tag).map(link => link.id), ["capture"]);
});

test("only the administrator role is shown", () => {
  assert.equal(roleLabel("admin"), "Administrateur");
  assert.equal(roleLabel("confirmed"), null);
  assert.equal(roleLabel("visitor"), null);
});

test("initials: one or two capital letters, accents and separators handled", () => {
  assert.equal(initials("alice"), "AL");
  assert.equal(initials("Alice Martin"), "AM");
  assert.equal(initials("jean-luc.picard"), "JP");
  assert.equal(initials("élodie"), "ÉL");
  assert.equal(initials("x"), "X");
  assert.equal(initials("  bob  "), "BO");
  assert.equal(initials(""), "?");
  assert.equal(initials("---"), "?");
  assert.equal(initials("😀smile"), "😀S"); // a letter is a code point, not a UTF-16 unit
  assert.equal(initials("Jean Luc Picard"), "JP");
});

test("menu keyboard navigation wraps and ignores other keys", () => {
  assert.equal(nextMenuIndex(0, "ArrowDown", 4), 1);
  assert.equal(nextMenuIndex(3, "ArrowDown", 4), 0);
  assert.equal(nextMenuIndex(0, "ArrowUp", 4), 3);
  assert.equal(nextMenuIndex(2, "Home", 4), 0);
  assert.equal(nextMenuIndex(1, "End", 4), 3);
  assert.equal(nextMenuIndex(-1, "ArrowDown", 4), 0);
  for (const key of ["Enter", " ", "Tab", "ArrowLeft", "ArrowRight", "a"]) assert.equal(nextMenuIndex(1, key, 4), null, key);
  assert.equal(nextMenuIndex(0, "ArrowDown", 0), null);
});

test("the basket's accessible name carries the number of items", () => {
  assert.equal(basketLabel(0), "Panier, vide");
  assert.equal(basketLabel(1), "Panier, 1 article");
  assert.equal(basketLabel(12), "Panier, 12 articles");
});

test("the back button has no target on the home page and goes up one level elsewhere", () => {
  for (const home of ["/", "/v2", "/v2/"]) assert.equal(backTarget(home), null, home);
  const cases = [
    ["/v2/produits", "/v2"], ["/v2/panier", "/v2"], ["/v2/parametres", "/v2"], ["/v2/magasins", "/v2"],
    ["/v2/produits/12", "/v2/produits"], ["/v2/produits/12/modifier", "/v2/produits/12"],
    ["/v2/produits/12/historique", "/v2/produits/12"], ["/v2/produits/nouveau", "/v2/produits"],
    ["/v2/recettes/5", "/v2/recettes"], ["/v2/recettes/5/modifier", "/v2/recettes/5"], ["/v2/recettes/nouvelle", "/v2/recettes"],
    ["/v2/magasins/7", "/v2/magasins"], ["/v2/brouillons/3", "/v2/brouillons"], ["/v2/parametres/securite", "/v2/parametres"],
    ["/v2/categories/Lait", "/v2/produits"], ["/v2/categories/P%C3%A2tes%2Friz", "/v2/produits"],
    ["/v2/capture/installer", "/v2"], ["/v2/produits/12/", "/v2/produits"],
    ["/v2/panier/demo", "/v2"], ["/v2/panier/demo/liste", "/v2/panier/demo"],
  ];
  for (const [path, parent] of cases) assert.equal(backTarget(path), parent, path);
});

test("going back always ends at the home page: every target leads towards it", () => {
  for (const start of ["/v2/produits/12/modifier", "/v2/recettes/5/modifier", "/v2/parametres/serveur", "/v2/categories/x", "/v2/capture/installer"]) {
    let path = start; const seen = new Set();
    while (path !== null && path !== "/v2") { assert.ok(!seen.has(path), `loop at ${path}`); seen.add(path); path = backTarget(path); }
    assert.equal(path, "/v2", start);
  }
});

test("a search goes to the catalogue with the trimmed, single-spaced text", () => {
  assert.equal(searchPath("lait"), "/v2/produits?q=lait");
  assert.equal(searchPath("  pâtes   tricolores  "), "/v2/produits?q=p%C3%A2tes+tricolores");
  assert.equal(searchPath("3017620422003"), "/v2/produits?q=3017620422003");
  assert.equal(searchPath("lait & miel=1"), "/v2/produits?q=lait+%26+miel%3D1");
});

test("an empty search goes nowhere", () => {
  for (const blank of ["", "   ", "\n\t "]) assert.equal(searchPath(blank), null);
});

test("a long search is cut to what the catalogue accepts", () => {
  const link = searchPath("a".repeat(500));
  assert.equal(new URLSearchParams(link.split("?")[1]).get("q").length, SEARCH_MAX_LENGTH);
  assert.equal(SEARCH_MAX_LENGTH, 120);
  const spaced = searchPath("a".repeat(119) + " " + "b".repeat(50));
  assert.ok(!new URLSearchParams(spaced.split("?")[1]).get("q").endsWith(" "));
});

test("the field shows the current catalogue search and is empty elsewhere", () => {
  assert.equal(searchTermFromLocation("/v2/produits", "?q=lait"), "lait");
  assert.equal(searchTermFromLocation("/v2/produits/", "?q=p%C3%A2tes+tricolores"), "pâtes tricolores");
  assert.equal(searchTermFromLocation("/v2/produits", ""), "");
  assert.equal(searchTermFromLocation("/v2/produits", "?category=Lait"), "");
  assert.equal(searchTermFromLocation("/v2/magasins", "?q=lait"), "");
  assert.equal(searchTermFromLocation("/v2/produits/12", "?q=lait"), "");
});

test("a search survives the round trip through the address", () => {
  for (const term of ["lait", "pâtes tricolores", "lait & miel=1", "50% réduit", "a/b"]) {
    const link = searchPath(term); const [path, query] = link.split("?");
    assert.equal(searchTermFromLocation(path, "?" + query), term, term);
  }
});

test("a path is matched without its trailing slashes", () => {
  const cases = [["/", "/"], ["", "/"], ["//", "/"], ["/v2", "/v2"], ["/v2/", "/v2"], ["/v2//", "/v2"], ["/v2/produits/12/", "/v2/produits/12"]];
  for (const [path, normalized] of cases) assert.equal(normalizePath(path), normalized, path);
});

test("every address of the site opens its page, with or without a trailing slash", () => {
  const recipe = (mode, id, privateRecipe = false) => ({ kind: "recipes", mode, ...(id === undefined ? {} : { id }), private: privateRecipe });
  const basket = (shared, demo, list) => ({ kind: "basket", shared, demo, list });
  const cases = [
    ["/", { kind: "home" }], ["/v2", { kind: "home" }],
    ["/v2/mentions-legales", { kind: "legal", doc: "mentions" }], ["/v2/confidentialite", { kind: "legal", doc: "confidentialite" }],
    ["/v2/conditions-utilisation", { kind: "legal", doc: "conditions" }],
    ["/v2/versions", { kind: "versions" }], ["/v2/changelog", { kind: "changelog" }],
    ["/v2/changelog/products", { kind: "changelog", component: "products" }],
    ["/v2/changelog/a%20b", { kind: "changelog", component: "a%20b" }],
    ["/v2/settings/database", { kind: "database" }],
    ["/v2/parametres", { kind: "settings" }], ["/v2/parametres/securite", { kind: "settings", tab: "securite" }],
    ["/v2/parametres/inconnu", { kind: "settings", tab: "inconnu" }],
    ["/v2/connexion", { kind: "auth", mode: "login" }], ["/v2/inscription", { kind: "auth", mode: "register" }],
    ["/v2/magasins", { kind: "stores" }], ["/v2/magasins/7", { kind: "stores", id: 7 }],
    ["/v2/a-completer", { kind: "completion" }],
    ["/v2/capture/installer", { kind: "capture", mode: "install" }], ["/v2/capture", { kind: "capture", mode: "review" }],
    ["/v2/panier", basket(false, false, false)], ["/v2/panier/liste", basket(false, false, true)],
    ["/v2/panier/partage", basket(true, false, false)], ["/v2/panier/partage/liste", basket(true, false, true)],
    ["/v2/panier/demo", basket(false, true, false)], ["/v2/panier/demo/liste", basket(false, true, true)],
    ["/v2/recettes", recipe("list")], ["/v2/recettes/nouvelle", recipe("new")],
    ["/v2/recettes/5", recipe("detail", 5)], ["/v2/recettes/5/modifier", recipe("edit", 5)],
    ["/v2/recettes/privees/5", recipe("detail", 5, true)], ["/v2/recettes/privees/5/modifier", recipe("edit", 5, true)],
    ["/v2/produits", { kind: "catalogue" }], ["/v2/categories/Lait", { kind: "catalogue", category: "Lait" }],
    ["/v2/categories/caf%C3%A9", { kind: "catalogue", category: "café" }],
    ["/v2/categories/P%C3%A2tes%2Friz", { kind: "catalogue", category: "Pâtes/riz" }],
    ["/v2/categories/%E0", { kind: "home" }],
    ["/v2/produits/nouveau", { kind: "workspace", mode: "new" }], ["/v2/brouillons", { kind: "workspace", mode: "mine" }],
    ["/v2/moderation", { kind: "workspace", mode: "review" }], ["/v2/brouillons/3", { kind: "workspace", mode: "draft", id: 3 }],
    ["/v2/produits/12", { kind: "workspace", mode: "detail", id: 12 }],
    ["/v2/produits/12/modifier", { kind: "workspace", mode: "edit", id: 12 }],
    ["/v2/produits/12/historique", { kind: "workspace", mode: "history", id: 12 }],
  ];
  for (const [path, route] of cases)
    for (const variant of [path, path + "/", path + "//"]) assert.deepEqual(parseV2Route(variant), route, variant);
});

test("an address the site does not have opens no page", () => {
  for (const path of ["/autre", "/v2/inconnu", "/v2/produitsx", "/v2/produits/12/autre", "/v2/produits/abc", "/v2/brouillons/x",
    "/v2/parametres/x/y", "/v2/settings", "/v2/settings/database/x", "/v2/magasins/abc", "/v2/magasins/7/modifier",
    "/v2/recettes/privees", "/v2/recettes/privees/nouvelle", "/v2/recettes/5/historique", "/v2/panier/partage/demo",
    "/v2/panier/liste/partage", "/v2/categories", "/v2/categories/a/b", "/v2/capture/autre", "/v2/changelog/a/b",
    "/v2/mentions-legales/x", "/V2", "/v3"])
    assert.equal(parseV2Route(path), null, path);
});

test("the legal pages the site lists are the ones it opens", () => {
  assert.deepEqual(LEGAL_DOCUMENTS.map(item => item.kind), ["mentions", "confidentialite", "conditions"]);
  for (const item of LEGAL_DOCUMENTS) assert.deepEqual(parseV2Route(item.path), { kind: "legal", doc: item.kind }, item.path);
});

test("every link of the dock, the profile menu and the back button opens a page", () => {
  const links = [
    ...["shopping", "contribute"].flatMap(mode => [false, true].flatMap(follows => dockItems(mode, follows).map(item => item.to))),
    ...[null, { username: "root", role: "admin" }].flatMap(user => ["shopping", "contribute"]
      .flatMap(mode => profileMenuSections(user, mode).flatMap(section => section.links.map(link => link.to)))),
    ...["/v2/produits/12/modifier", "/v2/recettes/privees/5/modifier", "/v2/panier/demo/liste", "/v2/categories/Lait"].map(backTarget),
  ];
  for (const to of links) assert.notEqual(parseV2Route(to), null, to);
});

test("a legal text stays readable without the Markdown renderer", () => {
  const text = "*Version du 5 novembre 2026.*\n\n## Contact\n\nÉcrire à **sini** : [contact](mailto:contact@example.org).\nRéponse sous un mois.\n\n\n";
  assert.deepEqual(plainLegalText(text), [
    "*Version du 5 novembre 2026.*",
    "Contact",
    "Écrire à sini : contact (mailto:contact@example.org).\nRéponse sous un mois.",
  ]);
});
