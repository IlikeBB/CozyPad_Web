import assert from "node:assert/strict";

const baseUrl = String(process.env.COZYPAD_TEST_API_URL || "http://127.0.0.1:5174");
const username = String(process.env.COZYPAD_TEST_USERNAME || "EFan");
const password = String(process.env.COZYPAD_TEST_USER_PASSWORD || "");
const sshPassword = String(process.env.COZYPAD_TEST_SSH_PASSWORD || "fixture-password");

if (!password) throw new Error("COZYPAD_TEST_USER_PASSWORD is required");

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-cozypad-request": "app",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

const login = await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ username, password }),
});
assert.equal(login.response.ok, true, JSON.stringify(login.body));
const cookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
assert.ok(cookie, "login cookie missing");

const name = `fixture-concurrent-${Date.now().toString(36)}`;
const created = await request("/api/ssh/servers", {
  method: "POST",
  cookie,
  body: JSON.stringify({
    name,
    host: "127.0.0.1",
    port: 22222,
    user: "fixtureconcurrent",
    defaultPath: "~",
  }),
});
assert.equal(created.response.status, 201, JSON.stringify(created.body));
const serverId = created.body.server.id;

try {
  const challenge = await request(`/api/ssh/servers/${encodeURIComponent(serverId)}/provision`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ password: sshPassword }),
  });
  assert.equal(challenge.response.status, 409, JSON.stringify(challenge.body));
  assert.equal(challenge.body.code, "HOST_KEY_UNKNOWN");
  const expectedHostFingerprint = challenge.body.confirmation.fingerprintSha256;

  const attempts = await Promise.all([
    request(`/api/ssh/servers/${encodeURIComponent(serverId)}/provision`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ password: sshPassword, expectedHostFingerprint }),
    }),
    request(`/api/ssh/servers/${encodeURIComponent(serverId)}/provision`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ password: sshPassword, expectedHostFingerprint }),
    }),
  ]);
  const successes = attempts.filter(({ response }) => response.ok);
  const duplicates = attempts.filter(({ body }) => body?.code === "DUPLICATE_PROFILE");
  assert.equal(successes.length, 1, JSON.stringify(attempts.map(({ response, body }) => ({ status: response.status, body }))));
  assert.equal(duplicates.length, 1, JSON.stringify(attempts.map(({ response, body }) => ({ status: response.status, body }))));
  assert.equal(successes[0].body.server.provisioningStatus, "ready");
  process.stdout.write("SSH provisioning integration: success + duplicate lock verified\n");
} finally {
  await request(`/api/ssh/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
    cookie,
  });
}
