import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-settings-tabs.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { SETTINGS_BASE_PATH, SETTINGS_TABS, nextTabIndex, resolveSettingsTab, settingsTabPath, visibleSettingsTabs } =
  await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

const anonymous = { loggedIn: false, admin: false };
const member = { loggedIn: true, admin: false };
const admin = { loggedIn: true, admin: true };
const ids = viewer => visibleSettingsTabs(viewer).map(tab => tab.id);

test("each kind of viewer sees only the tabs they may use", () => {
  assert.deepEqual(ids(anonymous), ["general"]);
  assert.deepEqual(ids(member), ["general", "account", "security"]);
  assert.deepEqual(ids(admin), ["general", "account", "security", "connectors", "server"]);
});

test("a visitor who is not signed in never gets an admin flag to count", () => {
  assert.deepEqual(ids({ loggedIn: false, admin: true }), ["general"]);
});

test("slugs are unique and the default tab comes first", () => {
  assert.equal(new Set(SETTINGS_TABS.map(tab => tab.slug)).size, SETTINGS_TABS.length);
  assert.equal(SETTINGS_TABS[0].id, "general");
});

test("the default tab keeps the historical bare path, the others get their own", () => {
  assert.equal(settingsTabPath("general"), SETTINGS_BASE_PATH);
  assert.equal(settingsTabPath("security"), `${SETTINGS_BASE_PATH}/securite`);
  assert.equal(settingsTabPath("server"), `${SETTINGS_BASE_PATH}/serveur`);
});

test("every tab path resolves back to its own tab for a viewer allowed to see it", () => {
  for (const tab of visibleSettingsTabs(admin).slice(1)) {
    const resolved = resolveSettingsTab(settingsTabPath(tab.id).split("/").pop(), admin);
    assert.equal(resolved.tab.id, tab.id);
    assert.equal(resolved.redirect, false);
  }
});

test("the bare path opens the default tab without a redirect", () => {
  assert.deepEqual(resolveSettingsTab(undefined, anonymous), { tab: SETTINGS_TABS[0], redirect: false });
});

test("unknown, forbidden and non-canonical addresses fall back to the default tab with a redirect", () => {
  for (const [slug, viewer] of [
    ["inconnu", admin], ["securite", anonymous], ["compte", anonymous],
    ["serveur", member], ["connecteurs", member], ["general", admin],
  ]) {
    const resolved = resolveSettingsTab(slug, viewer);
    assert.equal(resolved.tab.id, "general", slug);
    assert.equal(resolved.redirect, true, slug);
  }
});

test("a viewer who loses access while on a tab is sent back to the default tab", () => {
  assert.equal(resolveSettingsTab("securite", member).redirect, false);
  assert.equal(resolveSettingsTab("securite", anonymous).redirect, true);
});

test("arrow keys wrap around, Home and End jump, other keys are ignored", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 3), 1);
  assert.equal(nextTabIndex(2, "ArrowRight", 3), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 3), 2);
  assert.equal(nextTabIndex(1, "ArrowLeft", 3), 0);
  assert.equal(nextTabIndex(1, "Home", 3), 0);
  assert.equal(nextTabIndex(1, "End", 3), 2);
  for (const key of ["Enter", " ", "Tab", "a", "ArrowUp", "ArrowDown"]) assert.equal(nextTabIndex(1, key, 3), null, key);
  assert.equal(nextTabIndex(0, "ArrowRight", 0), null);
});
