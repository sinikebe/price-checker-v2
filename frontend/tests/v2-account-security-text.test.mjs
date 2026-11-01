import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/v2/v2-account-security-text.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { REGENERATE_CONFIRMATION, activationNotice, activationWarning, disableConfirmation } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("the activation warning says other devices are signed out and tokens revoked, whatever the count", () => {
  for (const count of [0, 1, 2, 12]) {
    const text = activationWarning(count);
    assert.match(text, /déconnecte vos autres appareils/, `count ${count}`);
    assert.match(text, /jeton/, `count ${count}`);
  }
});

test("the activation warning counts the active tokens", () => {
  assert.match(activationWarning(0), /aucun jeton API actif/);
  assert.match(activationWarning(1), /révoque aussi votre jeton API actif\./);
  assert.match(activationWarning(3), /révoque aussi vos 3 jetons API actifs\./);
});

test("the notice after activation reports what happened", () => {
  assert.doesNotMatch(activationNotice(0), /révoqué/);
  assert.match(activationNotice(0), /autres appareils ont été déconnectés\. Conservez/);
  assert.match(activationNotice(1), /votre jeton API a été révoqué/);
  assert.match(activationNotice(4), /vos 4 jetons API ont été révoqués/);
  for (const count of [0, 1, 4]) assert.match(activationNotice(count), /Double authentification activée/);
});

test("disabling asks for confirmation and names the tokens it revokes", () => {
  assert.equal(disableConfirmation(0), "Désactiver la double authentification ?");
  assert.match(disableConfirmation(1), /Votre jeton API actif sera révoqué\./);
  assert.match(disableConfirmation(5), /Vos 5 jetons API actifs seront révoqués\./);
});

test("renewing the recovery codes warns that the old ones stop working", () => {
  assert.match(REGENERATE_CONFIRMATION, /anciens codes seront annulés/);
});
