# CozyPad new-user UI audit — 2026-08-17

## Scope

- Environment: local web `http://localhost:5173`, API `5174`, local command service `5175`
- Test identity: a newly seeded non-admin account (`EFan`) with no existing SSH servers, threads, runs, or remote workspace
- Tested: login, first-load empty states, navigation, role isolation, SSH connection management, failed connection creation, logout/login switching
- Safety: no admin records were changed or deleted; the failed local-only SSH target used `127.0.0.1:1`; generated orphan test keys were removed after verification

## Result summary

The app renders every main workspace without crashing and backend account isolation works for SSH profiles, Codex threads, and runs. The new-user path is not yet ready for independent users because there is no registration flow, browser-local data is not scoped by account, and connection creation has misleading/destructive failure behavior.

## Findings

### NU-01 — Blocker — No registration or account-creation path

Evidence:

- The logged-out screen only provides username, password, and Login.
- The API exposes login, 2FA verification, logout, session, and password change, but no registration endpoint.
- `isAllowedLoginUser()` only accepts entries from the hard-coded `DEFAULT_USERS` list in `scripts/legacy-v2-api-server.mjs`.

Reproduction:

1. Log out.
2. Inspect the login screen.
3. Try to locate Register, Create account, Invite, or an administrator user-management page.

Observed: none exists. A new ordinary account had to be seeded directly in `data/auth-users.json` to continue this audit.

Recommendation: decide explicitly between self-service registration and invitation/admin provisioning. For this product, admin-created invitations with role assignment and first-login password/TOTP setup are safer than open registration.

### NU-02 — High — Browser state is shared across signed-in users

Evidence:

- The fresh ordinary account inherited the browser's existing Codex model (`gpt-5.6-sol`), effort (`high`), and review mode (`Approve for me`).
- Research state and multiple agent/task preferences use global keys such as `cozypad3.researchFlowcharts.v2`, `cozypad3.remoteCodex.model.v1`, `cozypad3.remoteCodex.reasoningEffort.v1`, and `cozypad3.remoteCodex.reviewPermission.v1`.
- The keys in `ResearchWorkspace.tsx`, `CodexAppServerPanel.tsx`, `LegacyCodexPanel.tsx`, `workRuns.ts`, and `sshServerPreference.ts` do not include the authenticated username.

Impact:

- One user can see or overwrite another user's local research drafts, task metadata, prompt drafts, model/effort preferences, review authorization preference, and UI state when accounts share a browser profile.
- Carrying a more permissive review mode to another account is a safety issue even when the backend data itself remains isolated.

Recommendation: introduce a user-scoped storage namespace, for example `cozypad3.user.<normalized-user>.<feature>.vN`; migrate only safe preferences and clear in-memory account state on logout/account change.

### NU-03 — High — Failed connection creation leaves an orphan SSH key pair

Reproduction:

1. As a new ordinary user, open Connection Manager.
2. Add a password-based target that cannot be reached (`127.0.0.1:1` was used).
3. Press Save.

Observed:

- No server profile is created.
- The UI reports raw `LegacyApiError: connect ECONNREFUSED 127.0.0.1:1`.
- A private/public key pair is generated under `data/users/<user>/keys/` before connection succeeds and remains after failure.

Recommendation: generate into a temporary location and atomically move it only after provisioning succeeds, or remove generated files in a `catch/finally` rollback path. Add a regression test for repeated failed attempts.

### NU-04 — Medium — “Save” actually performs remote provisioning

The form appears to save connection metadata, but for a new managed password profile it immediately opens SSH and installs a generated key. This is surprising, prevents saving an offline host for later, and makes connection errors look like form-save failures.

Recommendation: either split this into `Save profile` and `Connect & install key`, or rename the primary action to `Connect & add` and explain that one SSH login will occur.

### NU-05 — Medium — Non-admin Public administration UI is exposed

Observed:

- A normal user can open Public and sees enabled `Start / Repair` and `Restart tunnel` buttons.
- The page automatically receives `Admin account required` because the backend correctly protects `/api/public/*` with `requireAdmin()`.

Security result: no privilege escalation was found; backend enforcement is correct.

Recommendation: hide the Public navigation item for non-admin users, or show a read-only public status page and omit mutation controls. Do not rely on an enabled button followed by a 403 as the normal UX.

### NU-06 — Medium — Settings exposes stale mock/developer controls in the live app

The normal user sees `Developer (mock)`, an enabled `模擬非預期斷線` button, `Bridge mock`, and `Agent adapter 尚未接線（Phase 2/3）`, while the header reports Web/API/local command ready and the real SSH workflow is active.

Recommendation: gate developer controls behind a development flag and derive About/bridge status from the active runtime rather than placeholder copy.

### NU-07 — Low — SSH import reports a false-success style message for ordinary users

With no importable per-user config, `Import ~/.ssh` reports `Imported 0 SSH hosts from ~/.ssh/config.` This does not explain whether the file was empty, unavailable, or intentionally blocked from importing the host OS admin config.

Recommendation: distinguish `No config found`, `No valid Host entries`, and `Import unavailable for this account`; link to the expected per-user config location.

### NU-08 — Low — Empty connection form allows submit before client validation

Pressing Save with all required fields empty correctly shows `名稱、Host、Port、Username 都是必填。`, but the Save button remains enabled. This is functionally safe but creates avoidable failed interactions.

Recommendation: disable the primary action until required fields, port, and credential prerequisites are valid; retain server validation as the authoritative second layer.

## Passed checks

- Fresh user did not receive admin SSH servers.
- Fresh user did not receive admin Codex threads.
- Fresh user did not receive admin work runs.
- Connect, Terminal, File, Codex Send, Goal, Plan, review, model, and effort controls correctly remain disabled without an SSH target/connection.
- Monitor shows a coherent zero-server state.
- Backend rejects non-admin Public operations.
- Blank connection fields and invalid ports are validated.
- Switching back to admin restored the configured SSH profile list, and `NCKU146_91` reconnected successfully.

## Suggested fix order

1. Scope all browser storage by authenticated user and reset account-bound in-memory state.
2. Add rollback for failed SSH provisioning and clarify the Save/connect interaction.
3. Define and implement the intended account-provisioning flow.
4. Gate Public and developer/mock UI by role/environment.
5. Improve import and form-validation messages.
