import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-site-nav.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DOCK_ITEMS, SEARCH_MAX_LENGTH, activeDockId, backTarget, basketLabel, initials, nextMenuIndex, profileMenuSections, roleLabel, searchPath, searchTermFromLocation } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("the dock has the five main sections, each with a distinct address", () => {
  assert.deepEqual(DOCK_ITEMS.map(item => item.id), ["home", "products", "stores", "recipes", "basket"]);
  assert.equal(new Set(DOCK_ITEMS.map(item => item.to)).size, DOCK_ITEMS.length);
});

test("every page maps to the right dock item", () => {
  const cases = [
    ["/", "home"], ["/v2", "home"], ["/v2/", "home"],
    ["/v2/produits", "products"], ["/v2/produits/12", "products"], ["/v2/produits/12/historique", "products"],
    ["/v2/categories/Lait", "products"], ["/v2/magasins", "stores"], ["/v2/magasins/7", "stores"],
    ["/v2/recettes", "recipes"], ["/v2/recettes/nouvelle", "recipes"], ["/v2/panier", "basket"],
  ];
  for (const [path, id] of cases) assert.equal(activeDockId(path), id, path);
});

test("pages reached from the profile menu highlight no dock item", () => {
  for (const path of ["/v2/produits/nouveau", "/v2/brouillons", "/v2/moderation", "/v2/a-completer", "/v2/capture",
    "/v2/capture/installer", "/v2/parametres", "/v2/parametres/securite", "/v2/connexion", "/v2/produitsx", "/v2/recettesx"])
    assert.equal(activeDockId(path), null, path);
});

test("a signed-out visitor is offered to sign in, to contribute and to open the settings, but no admin links", () => {
  const links = profileMenuSections(null).flatMap(section => section.links.map(link => link.to));
  assert.deepEqual(links.slice(0, 2), ["/v2/connexion", "/v2/inscription"]);
  assert.ok(links.includes("/v2/parametres") && links.includes("/v2/produits/nouveau"));
  assert.ok(!links.some(to => to.includes("moderation") || to.includes("brouillons")));
});

test("a member sees their drafts, the settings and the contribution links, and nothing administrative", () => {
  for (const role of ["confirmed", "visitor"]) {
    const sections = profileMenuSections({ username: "alice", role });
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
  const all = profileMenuSections({ username: "root", role: "admin" }).flatMap(section => section.links);
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
