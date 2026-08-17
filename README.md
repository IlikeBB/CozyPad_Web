<h1 align="center">CozyPad Web</h1>

<p align="center">
  Remote research workspace for SSH terminals, agent conversations, file browsing,
  experiment diagrams, device monitoring, and public service checks.
</p>

<p align="center">
  <a href="./README.md"><kbd><strong>English</strong></kbd></a>
  &nbsp;
  <a href="./README.zh-TW.md"><kbd>Traditional Chinese</kbd></a>
</p>

<p align="center">
  <img alt="CozyPad Agents" src="docs/screenshots/feature-agents.png">
</p>

<p align="center">
  <strong>Remote agents</strong> · Codex / agy / baillian<br>
  <strong>Remote files</strong> · folder browsing / preview / path deep-link<br>
  <strong>Research workflow</strong> · Diagram / node feedback / MD.md / Start Training<br>
  <strong>Runtime target</strong> · SSH server first, localhost when selected
</p>

---

# English Guide

## Overview

CozyPad Web is a browser-based workspace for remote development and research. It combines SSH terminals, agent-driven work, remote file browsing, experiment diagrams, device monitoring, and public service diagnostics in one interface.

It is designed for users who frequently move between remote GPU servers, Linux machines, and local development environments.

## Feature Map

| Workspace | Features | Notes |
| --- | --- | --- |
| Research | Flowcharts, node feedback, Diagram analysis, MD.md, Start Training | Nodes are draggable and connectable. Each node keeps its own documentation and agent prompt. |
| Agents | Remote Codex, agy, and baillian panels | Supports Markdown, code highlighting, LaTeX formulas, image attachments, path deep-links, task stop, and edit-on-right-click for sent prompts. |
| Terminal | Multi-tab SSH/local terminal | Uses xterm, quick commands, copy/paste, narrow-screen key bar, and controlled reconnect behavior. |
| File | Remote file browser and previewer | Supports folders, path copy, image/PDF/Markdown/text/audio/video preview, agent path deep-linking, rename, delete, and folder creation. |
| Work | Task tracking | Agent and training jobs can link back to their related workspace. |
| device Monitor | SSH live resource monitor | Shows CPU, RAM, disk, GPU, GPU process, temperature, and online server drawer. |
| Public | Public service health checks | Helps diagnose API, origin, tunnel, Cloudflare security, and timeout states. |
| Settings | Runtime and connection settings | Controls tmux, desktop behavior, remote runtime, host key, and dev options. |

## Research Lab

Research Lab turns experiment planning into an editable diagram.

| Capability | Description |
| --- | --- |
| Flowchart tabs | Create, rename, delete, and switch independent flowcharts. |
| Diagram canvas | Move nodes, box-select multiple nodes, connect ports, and delete selected edges. |
| Node templates | Input, Output, Dataset, Model, Train, Evaluate, and Application. |
| Node detail | Click a node to open a Markdown-based detail dialog. |
| Node feedback | Generate broader research feedback for every node and feed it into Diagram analysis. |
| Agent Draw | Ask an agent to create or revise the current Diagram from natural language. |
| MD.md | Main training-plan Markdown generated from the Diagram. |
| Start Training | Creates an agent-backed training job from the Diagram and MD.md content. |

## Agents

Agents run against the selected remote server. CozyPad does not replace remote work with a local CLI unless the target is explicitly localhost.

| Agent | Purpose | Availability |
| --- | --- | --- |
| Codex | Remote Codex CLI work, code changes, and research assistance | Available |
| agy | Remote agy CLI work | Available |
| baillian | Bailian-related agent work with user-supplied runtime key | Available |

The chat interface supports:

| Content | Rendering |
| --- | --- |
| User messages | Right-side bubbles with right-click edit. |
| Agent text replies | Left-side Markdown rendering. |
| Tool/status output | Collapsible process bubbles. |
| Code | Syntax-highlighted code blocks. |
| Math | KaTeX/LaTeX formulas. |
| Images | Drag-and-drop, paste attachments, and previews for agent-generated image paths. |
| Remote paths | `/home/...`, `/ssd...`, and similar paths in text, Markdown links, inline code, and tool output can open the File workspace directly. |

### Agent Path And Image Preview

When an agent reply contains a remote path, CozyPad turns it into an interactive File link at render time. Agents do not need to emit custom UI markup.

| Reply content | Behavior |
| --- | --- |
| `/ssd8/project/output.png` | Shows an image preview in the chat and can open the File workspace. |
| `` `/ssd8/project/train.py` `` | Inline code that is exactly a remote path becomes a File link. |
| `/home/user/project` | Opens the folder in File. |
| `/home/user/result.png` | Opens the parent folder, selects the file, and previews it. |

## Terminal

The Terminal workspace uses xterm and supports both remote SSH and local terminal sessions.

| Feature | Description |
| --- | --- |
| SSH terminal | Opens an interactive terminal on the selected server. |
| Local terminal | Uses local terminal mode when localhost is selected. |
| Quick commands | Includes common commands such as `ls -la`, `pwd`, `git status`, `nvidia-smi`, `df -h`, and `tmux ls`. |
| Narrow-screen controls | Provides a key bar and press-and-hold input behavior. |
| Reconnect control | Avoids aggressive automatic SSH retry loops. |

## Files

The Files workspace is a remote file browser and preview surface.

| Feature | Description |
| --- | --- |
| Directory browser | Navigate into folders while keeping left and right panes synchronized. |
| Path actions | Copy current path, go up one level, refresh, and open a typed path. |
| Context menu | Rename/delete items and create folders from empty-space context menu. |
| Preview | Images, PDFs, Markdown, text, audio, and video. |
| Editor | Monaco-based text/code editing for supported files. |
| Back navigation | Browser back shortcuts move up one folder instead of resetting the page. |
| Agent deep-link | Clicking a file path from an agent message opens the parent folder and previews the target file. |

## device Monitor

device Monitor reads live resource data from connected SSH servers.

| Area | Content |
| --- | --- |
| Left | Host name, CPU, RAM, disk, and GPU overview. |
| Center | GPU utilization, VRAM, temperature, power, and process summary. |
| Right drawer | Online servers only. Offline servers are hidden from the selectable drawer. |
| Controls | Pause, Refresh, real time mode, interval, and selected monitor state. |

## Public Status

Public Status helps identify whether an outage is caused by the API, web origin, tunnel, Cloudflare security, or a timeout.

| Check | Description |
| --- | --- |
| API | CozyPad API health. |
| Web origin | Web origin response. |
| Tunnel | Cloudflare Tunnel connector state. |
| Public URL | Edge/security response and public entry status. |

## Getting Started

### Web development

```powershell
pnpm install
pnpm dev
```

### Legacy API / SSH features

```powershell
pnpm legacy-v2:api
```

### Desktop development

```powershell
pnpm dev:desktop
```

### Windows installer

The desktop app uses Electron Builder with NSIS.

```powershell
pnpm --filter @cozypad/desktop package
```

### Android support

Android/Capacitor support is temporarily paused for V4. It is not part of the pnpm workspace, build, test, lint, or release flow.

## Repository Layout

| Path | Description |
| --- | --- |
| `apps/app` | React + Vite web application. |
| `apps/desktop` | Electron wrapper and Windows installer configuration. |
| `packages/contracts` | Shared contracts and types. |
| `packages/remote-services` | Remote service and SSH/agent abstractions. |
| `packages/tmux-runtime` | tmux runtime utilities. |
| `scripts/legacy-v2-api-server.mjs` | Legacy API, SSH, agent, monitor, and public status backend entry. |
| `docs/screenshots` | Public screenshots for README and releases. |

## Security Notes

| Area | Policy |
| --- | --- |
| Private data | Do not commit `.env`, tokens, SSH keys, runtime keys, logs, data, or local private configs. |
| SSH | Avoid automatic repeated retries after failures; prefer reusing established sessions. |
| File actions | Destructive actions are performed through explicit UI commands. |
| Cloudflare | Can be paired with Tunnel, WAF, Access, or bot checks for public entry protection. |
| Agent keys | Runtime keys are user-supplied and must not be committed to the public repository. |

## Recent Updates

| Date | Update |
| --- | --- |
| 2026-08-13 | Split the README into separate English and Traditional Chinese pages with HTML-style language switch buttons. |
| 2026-08-13 | Fixed idle/page-switch stalls: API requests now have timeout guards, and Codex, agy, baillian, and Claude running tasks detect stale WebSockets on focus and reattach to the same task. |
| 2026-08-13 | Remote paths in agent replies now open File links across Markdown, inline code, plain text, and tool/status bubbles. |
| 2026-08-13 | Chat now previews agent-generated image paths and can jump from the preview to the File workspace. |
| 2026-08-13 | Fixed File deep-link behavior for file paths from agents: files now open through their parent folder and preview pane instead of being browsed as folders. |
| 2026-08-13 | Improved Files listing timeout and large-directory handling to reduce aborted requests and frozen UI states. |
| 2026-08-12 | Rebuilt README as a bilingual document based on the current Web feature set. |
| 2026-08-12 | Improved Agent message rendering with Markdown, code, math, process bubbles, and sent-message editing. |
| 2026-08-12 | Improved Files navigation, path actions, media preview, and context menu operations. |
| 2026-08-12 | Added interactive Research Diagrams, node feedback, Agent Draw, and Start Training workflow. |
| 2026-08-12 | Updated device Monitor around single-machine views and online-server drawer. |

## Contributors

| Contributor | Role |
| --- | --- |
| IlikeBB | Maintainer |
| youchengchao | Collaborator |
| yifanwang | Collaborator |
