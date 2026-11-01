import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-site-nav.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DOCK_ITEMS, activeDockId, basketLabel, initials, nextMenuIndex, profileMenuSections, roleLabel } = await import(
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
