# CozyPad Web TT

Independent browser-only CozyPad V4 rewrite. React, Vite and the pnpm workspace layout are retained. Electron, Flutter, Android, legacy web bundles, local command bridges and unused research/deployment tools are omitted.

## Run

Requires Node.js 22 or newer and pnpm 11.25.0.

```powershell
git clone --branch CozyPad_TT https://github.com/IlikeBB/CozyPad_Web.git
cd CozyPad_Web
pnpm install
Copy-Item .env.example .env
```

For a fresh installation, set `COZYPAD_ADMIN_PASSWORD` in `.env` to a password of at least 12 characters, then start the application:

```powershell
pnpm dev
```

Default web URL: http://127.0.0.1:5673. API: http://127.0.0.1:5674. The development launcher finds another port if necessary. Ports and authentication lifetimes can be configured in `.env`, using `.env.example` as a reference.

For production, run `pnpm build`, then `pnpm start`. The Node backend serves both the compiled website and API on the API port. A reverse proxy must forward WebSocket upgrades and avoid buffering event streams. Set `COZYPAD_PUBLIC_ORIGIN` to the exact HTTPS origin and `COZYPAD_COOKIE_SECURE=true` before public deployment.

The optional Windows Cloudflare launcher requires your own tunnel. Copy `scripts/cloudflare-public.example.json` to `scripts/cloudflare-public.json`, configure its tunnel ID and hostname, and install the matching credentials in your user profile before running `start-public.cmd`. The actual deployment configuration and credentials are not included in this repository.

## Retained Tools

- Per-user SSH connection management: add, edit, delete, and upload/import `ssh_config` with matching private keys.
- Interactive SSH terminal using xterm.js and WebSocket, with heartbeat and retained-shell reconnection.
- SFTP directory browsing, text editing with revision checks, upload and download.
- Drag existing files onto folders in Files or the Codex explorer to move them on the selected SSH server. Conflicting names are never overwritten; open previews and unsaved editors follow the new path. A Move action also supports keyboard and touch input.
- Inline image and video previews in Files and Codex file tabs. Images support fit-to-window and zoom; videos use native playback, seeking, volume and fullscreen controls. Authenticated byte-range streaming supports large media without buffering the whole file. PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG, MP4/M4V, WebM, OGV and MOV are recognized; decoding depends on browser support. Unreadable media offers retry and download.
- Remote Codex tasks, expandable process records, streaming responses, persistent history, continuation, mid-turn guidance and cancellation. Interactive questions open a selection dialog and wait for explicit confirmation.
- Streaming Codex output does not use a cumulative 4 MB transport limit; individual protocol records and displayed history remain bounded.
- Read formatted Markdown from SSH or explicitly selected local files, with preview/source switching. Local Markdown previews stay in the browser.
- Interactive `nvtop` and `htop` terminals stacked vertically for remote GPU and process monitoring.

SSH runs from this backend host to the selected server using that user's encrypted private key. Public keys must already be installed in the server account's `authorized_keys`. Encrypted keys require their passphrase when uploaded. Jump hosts are not supported; imports report these as skipped. Remote Codex uses the selected SSH account's installed CLI and login.

Browsers cannot silently read a visitor's `.ssh/config` or local private keys. Each user explicitly selects their own config/key files. Uploaded config never executes `Match exec`, reads arbitrary backend file paths, or falls back to admin credentials.

## Login

An explicit legacy import preserves existing usernames, password hashes and TOTP registrations. The first login after import requires the existing authenticator code. After successful verification, the checked trust option remembers the browser for 7 days by default. Password verification still applies to every login. The trust expiration is fixed and survives logout/server restart; it can be revoked in Settings. Expired trust, a different user/browser, or changed credentials requires verification again.

Session and trust cookies have separate names, are HttpOnly and SameSite=Strict, and use Secure with HTTPS configuration. Only hashes of random cookie tokens are stored. Login sessions expire after 12 hours by default. TOTP challenges expire after 5 minutes, enforce attempt limits and reject replayed codes.

`data/users/<username>/` isolates connections and task history. SSH keys are encrypted using AES-256-GCM; keep `data/keyring.key` with the encrypted data when backing up. `data/`, `.env`, logs and generated builds are ignored by Git. An empty installation requires `COZYPAD_ADMIN_PASSWORD` with at least 12 characters, or an explicit one-time `pnpm import:legacy <source-directory>`.

## Source Map

| Directory | Responsibility |
| --- | --- |
| `apps/app/src/components/` | Login, connection editor and shared UI controls |
| `apps/app/src/workspaces/` | Agents, terminal, files, Markdown, monitor and issue reports |
| `apps/server/src/auth/` | Password, TOTP, session and trusted-browser verification |
| `apps/server/src/ssh/` | SSH connections, host-key checks, SFTP, terminal and Codex |
| `apps/server/src/storage/` | Atomic per-user JSON storage and encrypted key vault |
| `packages/contracts/src/` | Browser/API data types |
| `scripts/` | Development startup, source checks and explicit migration |
| `tests/` | Authentication, isolation, transport and browser checks |

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
```

The browser checks use temporary accounts and a local SSH test server. They do not send tasks to the real saved servers.
