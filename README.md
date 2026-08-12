# CozyPad4

基於 `CozyPad-0.2.9-alpha` 持續演進的遠端工作站專案。

**把手機／電腦連上遠端主機上的 coding agent 的工作站。**

CozyPad 讓你從 Windows 桌面或 Android 手機，透過 SSH 管理遠端 Linux 主機：
多分頁終端機、檔案瀏覽與編輯、CPU/GPU 監控，以及（開發中的）Claude Code /
Codex / agy 等 remote agent 的對話介面。Agent 全部跑在遠端 tmux 裡——關掉
app、斷線、換裝置，工作都不會中斷。

一套 **React + TypeScript** codebase，桌面包 **Electron**、Android 包
**Capacitor**；桌面安裝包約 100MB、Android release APK 約 7MB
（實際大小依版本與簽章而異）。

> 完整規格見 [SPEC.md](SPEC.md)；本 README 只講怎麼跑起來。

## Contributors

| GitHub | 角色 |
| --- | --- |
| [IlikeBB](https://github.com/IlikeBB) | 專案維護與 CozyPad4 整合 |
| [youchengchao](https://github.com/youchengchao) | CozyPad 上游原始專案與協作開發 |
| [yifanwang](https://github.com/yifanwang) | 專案協作與功能測試 |

## 近期更新

| 日期 | 更新項目 |
| --- | --- |
| 2026-08-01 | 此 repository 目前沒有留下可追溯的 commit 紀錄；功能整理以後續提交為準。 |
| 2026-08-02 | 建立中文 README 與截圖整理；移除公開展示文字；將功能預覽區塊改為安裝教學；日期格式改為單日紀錄。 |
| 2026-08-03 | 補上 Markdown summary 測試資料與整理範例；清理 README 中不需要的公開展示描述。 |
| 2026-08-04 | 整理 8/4 CozyPad 更新：Cloudflare / DDNS 相關說明、agent 介面方向、遠端服務串接與 markdown workflow。 |
| 2026-08-05 | 更新近期變更紀錄與功能截圖，補充 Claude / Codex / agy、Files、Monitor、Research / Markdown workflow 的文件說明。 |
| 2026-08-06 | 將 CozyPad4 同步到 Web repository；加入 MIT License；移除過時 V3 檔案；調整 README 為安裝導向；修正 Claude / Codex / agy 重新連線時重播舊輸出與忘記上下文的問題；SSH / terminal / agent session 預設保留 24 小時；補上 Cloudflare edge 403 fallback 與 CORS preflight；新增 Contributors 並標註上游協作者。 |
| 2026-08-07 | 同步 CozyPad V4 Web 功能，整理 Agents、Research、Terminal、Files、Monitor 的主介面；隱藏暫停使用的 Claude 服務入口，保留 Codex、agy、Bailian 的遠端工作流方向。 |
| 2026-08-11 | 準備 CozyPad beta release：清理不必要的大型檔案與 log，保留公開文件、安裝說明與核心 Web 應用程式；將新版內容整理到 main 分支。 |
| 2026-08-12 | 穩定化 workspace 互動：Research 重置流程圖改為清空目前 tab；Terminal 避免未連線時自動啟動遠端 SSH；Codex / agy / Bailian 新增右鍵編輯已送出訊息，採用「停止目前 CLI 任務後重新執行」的安全流程。 |

## 現在能用的功能

| 功能 | 狀態 |
| --- | --- |
| SSH 連線管理（密碼／SSH Key、OS 安全儲存、host key 驗證、斷線自動重連） | ✅ |
| 多分頁終端機（xterm.js、右鍵複製貼上、常用指令面板、手機 Termux 式按鍵列） | ✅ |
| 遠端檔案：類型圖示、symlink 跳轉、任意路徑導覽、下載保留原始檔名、右鍵／長按選單、兩段式複製搬移 | ✅ |
| 檔案編輯：Monaco（VS Code 引擎）語法高亮、Ctrl+S 直接存回遠端；Markdown 預覽；PDF 內嵌檢視 | ✅ |
| 監控：CPU／記憶體／GPU 與 GPU processes，每 5 秒更新 | ✅ |
| 遠端設定：tmux 滑鼠模式開關；tmux 缺失時一鍵使用者層級安裝 | ✅ |
| Agents 對話（Claude / Codex / agy） | 🚧 架構與 parser 完成，接線中 |
| Research Lab（實驗管理） | 🚧 UI 雛形 |

## 安裝教學

| 步驟 | 指令 / 操作 |
| --- | --- |
| 1. 安裝 Node.js LTS | 建議使用目前 LTS 版本。 |
| 2. 啟用 pnpm | `corepack enable` |
| 3. 安裝套件 | `pnpm install` |
| 4. 啟動 Web 開發版 | `pnpm dev` |
| 5. 啟動 API | `pnpm legacy-v2:api` |
| 6. 型別檢查 | `pnpm typecheck` |

## 快速開始

### 需求

只需要 **Node.js LTS + pnpm**（不需要 Flutter、Rust、Visual Studio、Android Studio）：

```bash
corepack enable   # 或 npm install -g pnpm
pnpm install
pnpm test         # 全綠即環境就緒
```

### 日常使用

| 做什麼 | 操作 |
| --- | --- |
| 連真實主機使用 | 雙擊 `CozyPad.bat`，或 `pnpm --filter @cozypad/desktop start` |
| Demo（內建假主機，零設定） | 雙擊 `CozyPad-Demo.bat` |
| UI 開發（瀏覽器熱更新） | `pnpm dev` → http://localhost:5173 |
| 桌面開發（Electron 熱更新，mock） | `pnpm dev:desktop` |
| 桌面開發（真 SSH） | `pnpm dev:desktop:ssh` |
| Android debug APK | `pnpm --filter @cozypad/mobile apk:debug`（需 Android SDK + JDK 21） |
| Android signed release APK | 設定簽章環境變數後執行 `pnpm --filter @cozypad/mobile apk` |
| 檢查 | `pnpm lint` / `pnpm typecheck` / `pnpm test` |

第一次連主機：右上 **⚙** 新增連線 → 選擇「密碼」或「SSH Key」→ Connect
→ 核對並確認 host key 指紋。關閉「以 OS 安全儲存保留驗證資料」時，憑證只保留
到本次 app 結束，期間仍可自動重連。

更多細節：[docs/TUTORIAL_ELECTRON_CAPACITOR.md](docs/TUTORIAL_ELECTRON_CAPACITOR.md)
（從零到日常 routine，含手機 live reload）。

## Repository 結構

```
apps/
  app/        共用 React UI（桌面與手機同一套；可純瀏覽器 + mock 開發）
  desktop/    Electron shell：SSH/ssh2、加密憑證、telemetry、檔案操作、tmux
  mobile/     Capacitor Android shell
packages/
  contracts/      Zod schemas、PlatformBridge、IPC 協定（跨平台唯一事實來源）
  telemetry/      /proc/stat、free、nvidia-smi 解析
  tmux-runtime/   tmux session 管理、reconciliation、佈建
  adapter-claude/ Claude CLI stream-json → normalized events
  test-fixtures/  mock 檔案系統／PTY／telemetry／agent 資料
docs/           開發指南、教學、ADR、協定
lib/ 等          舊 Flutter 版（cutover 前保留，勿改）
```

架構鐵則（lint 強制）：`apps/app` 不得直接 import 任何平台 API——一律經由
`PlatformBridge`。這使桌面殼未來可整顆替換（Electron ⇄ Tauri）而不動 UI。

## 完整移除

CozyPad 只寫三個地方，全部可以清乾淨：

| 位置 | 內容 | 怎麼清 |
| --- | --- | --- |
| Windows 本機 | 程式本體 + Electron user data（連線設定、加密憑證、known hosts、快取） | 從「設定 → 應用程式」解除安裝即可，**app data 會一併刪除** |
| Android | app 私有資料 | 一般解除安裝即可（Android 保證清除私有目錄）；你主動下載的檔案留在 `Downloads/CozyPad`（Android 7–9 則是儲存時選擇的位置） |
| 遠端主機 | `~/.cozypad/`（建置暫存與 log）、shell rc 與 `~/.tmux.conf` 的 CozyPad 管理區塊、（若由 CozyPad 安裝）`~/.local/bin/tmux` | **Settings → 移除與清理 → 清除**（可選是否一併移除 tmux）；只動 CozyPad 自己的區塊，不碰你其他設定 |

安裝 tmux 用的建置暫存（數百 MB）在安裝成功後會自動刪除，不需手動處理。

## 安全性

- Desktop 以 Electron `safeStorage` 加密整份連線 profile 與 host trust（包含名稱、
  host、port、username、密碼、私鑰與 passphrase），舊版明文 metadata 會在首次載入時
  原子遷移；Android 以 Android Keystore 管理的 AES-256-GCM 金鑰保護 profile secret
  與 host trust。儲存後不再把 secret 回傳 renderer／WebView
- 已記憶的憑證綁定 profile ID、host、port、username 與驗證方式，避免
  profile metadata 遭竄改後把憑證送往其他主機
- SSH host key 使用標準 OpenSSH `SHA256:` fingerprint；首次或變更時必須確認，
  已信任資料只由 privileged platform layer 管理
- Desktop 與 Android 僅協商現代 SSH 演算法；SHA-1、DSA、CBC、3DES、RC4 與 MD5
  不會為相容老舊伺服器而自動降級
- Renderer 全程 sandbox + contextIsolation + 嚴格 CSP；IPC 雙向 Zod 驗證
- 不執行模型產生的任意 shell 字串（見 [ADR 0001](docs/adr/0001-solution-agent-bridge.md)）
