# CozyPad user isolation / SSH capability UX test report

Date: 2026-08-17  
Environment: local web `http://localhost:5173`, API `:5174`, local command bridge `:5175`

## Implementation checkpoint

- Browser state now uses `cozypad4.user.<normalized-user>.<feature>` storage keys.
- Legacy global preferences migrate once to admin only. Review/full-access state is excluded.
- Fresh users default to `Ask for approval`, model `default`, and effort `auto`.
- Session capabilities drive both navigation and restricted backend routes.
- SSH profiles support `pending` save without SSH and a separate provisioning request.
- Provisioning confirms the host fingerprint before sending the password, uses a per-user/host lock, generates keys in a temporary directory, tags the remote key, verifies key login, commits the profile, and attempts exact-key rollback on failure.
- SSH failures return `code`, `stage`, `retryable`, and `cleanup`; the UI converts these into next-step messages.

## Passed user flows

1. Admin session showed existing SSH profiles, Public, Import `~/.ssh`, and developer-authorized surfaces.
2. The long admin connection list accepted mouse-wheel scrolling and exposed the final row/actions without moving the page behind it.
3. Logout and fresh-user login produced an empty SSH list and did not expose admin profiles.
4. Fresh user did not see Public or Import `~/.ssh`.
5. Fresh user started with Review `Ask for approval`, model `default`, and effort `auto`.
6. Submitting an entirely blank SSH form stayed in the form and showed a required-fields error.
7. `Save without connecting` accepted name/host/port/username with no password, created a visible `pending` profile, kept Connect disabled, and left the user's key directory empty.
8. An unreachable reserved test host produced a structured `verifying-host` failure without creating a key.
9. The test profile could be deleted through the two-step delete confirmation.
10. Logging back into admin restored its previous `gpt-5.6-sol`, effort `high`, Review `Approve for me`, and SSH list. Fresh-user defaults did not overwrite admin preferences.
11. A disposable SSH server bound only to `127.0.0.1:22222` exercised host-fingerprint cancel and retry without touching any real host.
12. Correct fixture credentials completed key generation, remote install, key authentication, profile commit, and a subsequent Connect; the profile changed to `ready` and exposed one managed key only.
13. A reachable fixture with the wrong password returned an actionable authentication message, retained the form, and succeeded after correcting the password.
14. A forced key-verification failure removed the generated local key and reported `Rollback completed` with profile state `failed`.
15. A forced remote-cleanup failure produced a persistent `cleanup-required` profile and explicitly told the user that remote cleanup remained.
16. A parallel integration request against the same user/host produced exactly one successful provisioning and one `DUPLICATE_PROFILE`; only one profile/key was committed.
17. All disposable profiles were deleted through the visible two-step UI; the test user's profile file and managed key directory were empty afterward. The local SSH fixture was then stopped.

## Flows not completed

- Keyboard-only login was not repeated after the account-switch test because the modal keyboard defects below already block a complete keyboard-only pass.
- Host-key *change after prior trust* was covered by backend comparison logic but was not forced through the visible UI; doing so would require restarting the fixture with a new host key while retaining the same profile.

## UX findings

### UX-001 — High

- Page/function: Connection Manager modal
- User goal: Manage SSH profiles without interacting with the page behind the modal.
- Operation: Keyboard
- Preconditions: Connection Manager open.
- Reproduction: Open Connection Manager, press Tab three times, then inspect the visible focus target.
- Actual: Focus is not moved into the modal and ends on `BODY`; the background application remains in the focus order.
- Why awkward/risky: Keyboard users cannot tell where they are and may trigger background controls while believing the modal owns focus.
- Expected: Initial focus on Close or the first form control; Tab/Shift+Tab trapped inside the modal; focus returned to the gear button on close.
- Suggested direction: Add a reusable modal focus manager/focus trap and restore the opener element.
- Evidence: DOM focus inspection reported `document.activeElement === BODY` while the modal was open.

### UX-002 — Medium

- Page/function: Connection Manager modal
- User goal: Close a modal with the standard keyboard shortcut.
- Operation: Keyboard
- Preconditions: Connection Manager open.
- Reproduction: Press Escape.
- Actual: The modal remains open.
- Why awkward: Escape is an expected modal action and is required for a complete keyboard flow.
- Expected: Escape closes a list-only modal. If a dirty form is open, confirm before discarding input.
- Suggested direction: Centralize Escape handling in the same modal utility as UX-001.
- Evidence: The modal heading and Close button remained present after Escape.

### UX-003 — Medium

- Page/function: SSH provisioning form
- User goal: Understand failure and retry the correct step.
- Operation: Mouse
- Preconditions: Pending profile targeting an unreachable host.
- Reproduction: Edit profile, enter a password, press `Add & Connect`.
- Actual: The stage is visible, but the first implementation exposed the low-level text `connect EACCES ...`; canceling the form also left the old error in the list view.
- Why awkward: It does not explain what to check, and a form-specific error becomes detached from its form.
- Expected: A stable product message naming host/port/VPN/firewall checks; closing the form clears the form error.
- Resolution in this pass: Added structured error-to-message mapping and cleared error/stage/confirmation when Cancel closes the form.

### UX-004 — Medium

- Page/function: Pending-profile edit form
- User goal: Provision an already saved profile.
- Operation: Mouse
- Preconditions: A `pending` profile already exists.
- Reproduction: Open Edit.
- Actual: Primary action still says `Add & Connect`, although no profile is being added.
- Why awkward: The label contradicts the object lifecycle and makes users unsure whether a duplicate will be created.
- Expected: Use `Provision & Connect` (or `Connect`) for an existing pending profile; reserve `Add & Connect` for a new profile.
- Suggested direction: Derive the label from `form.id` and `provisioningStatus`.

### UX-005 — Low

- Page/function: Connection Manager profile metadata
- User goal: Understand whether a profile is ready to use.
- Operation: Mouse
- Preconditions: Imported and CozyPad-managed profiles are mixed.
- Reproduction: Open admin Connection Manager.
- Actual: The initial status fallback labelled every imported profile `ready`, even when identity readiness was not established.
- Why awkward: It can imply a verified key connection that never occurred.
- Expected: Distinguish `imported`, `not-provisioned`, `pending`, `ready`, `failed`, and `cleanup-required`.
- Resolution in this pass: Imported profiles now show `imported`; local profiles without a usable identity show `not-provisioned`.

## Product decisions needed

1. Should clicking the backdrop close a dirty SSH form, require confirmation, or do nothing?
2. Should Escape close only clean forms, or open a discard confirmation for dirty forms?
3. Confirm the existing-profile label: `Provision & Connect` versus simply `Connect`.
4. Provide a disposable SSH fixture if the full host-key/password/rollback matrix should be certified through the real UI.
