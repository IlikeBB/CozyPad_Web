import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesForIdentity, identityHasCapability } from "./capabilities.mjs";

test("ordinary users only receive base capabilities", () => {
  assert.deepEqual(capabilitiesForIdentity({ username: "EFan", role: "user" }, {
    adminUsername: "admin",
    nodeEnv: "development",
  }), ["agent.use", "research.use", "ssh.manage-own"]);
  assert.equal(identityHasCapability({ username: "EFan", role: "user" }, "public.read"), false);
});

test("admin receives management capabilities", () => {
  const values = capabilitiesForIdentity({ username: "admin", role: "admin" }, {
    adminUsername: "admin",
    nodeEnv: "development",
  });
  assert.equal(values.includes("ssh.import-system-config"), true);
  assert.equal(values.includes("public.manage"), true);
  assert.equal(values.includes("developer.simulate-drop"), true);
});

test("developer controls are denied in production", () => {
  assert.equal(capabilitiesForIdentity({ username: "admin", role: "admin" }, {
    adminUsername: "admin",
    nodeEnv: "production",
  }).includes("developer.simulate-drop"), false);
});

test("unknown capabilities are denied by default", () => {
  assert.equal(identityHasCapability({ username: "admin", role: "admin" }, "unknown.feature"), false);
});
