import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The gateway is a React component with no test renderer here, so this reads its source: signing in,
// registering and creating the first administrator all end in `authenticated(user)`.
const gateway = readFileSync(new URL("../src/v2/V2Gateway.tsx", import.meta.url), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is defined`);
  return source.slice(start, source.indexOf("\n  }\n", start));
}

test("signing in keeps the account for offline use before the signed-in page shows", () => {
  // It used to be kept only by the session read at start-up: going offline before the next reload
  // opened the app signed out, without the account's baskets.
  const body = functionBody(gateway, "authenticated");
  const remembered = body.indexOf("rememberOfflineUser(user);");
  assert.notEqual(remembered, -1, "authenticated() remembers the account");
  assert.ok(remembered < body.indexOf("setAuthStatus("), "before the signed-in state is set");
});

test("every sign-in form reports to the same handler", () => {
  const forms = [...gateway.matchAll(/<V2AuthPage [^>]*\/>/g)].map(match => match[0]);
  assert.equal(forms.length, 2, "the first administrator, and signing in or registering");
  for (const form of forms) assert.match(form, /onAuthenticated=\{authenticated\}/);
});
