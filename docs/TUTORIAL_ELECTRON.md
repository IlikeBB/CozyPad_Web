# Tutorial: Electron app development

**CozyPad V4 = React/Vite Web app + Electron Desktop shell.**
Android/Capacitor support is paused and is not part of daily development.

## 0. 從零安裝（新電腦一次性）

1. 安裝 [Git](https://git-scm.com/) 與 [Node.js LTS](https://nodejs.org/)（或 `winget install OpenJS.NodeJS.LTS`）。
2. 裝 pnpm：`npm install -g pnpm`。
3. Clone repo 後在根目錄執行：`pnpm install`。
4. 驗證環境：`pnpm test`。

不需要 Flutter、Dart、Rust、Visual Studio、Android Studio 或 Android SDK。

## 1. 日常 routine

1. `pnpm dev`：瀏覽器開 http://localhost:5173，使用 mock bridge，不需要 Electron 或真 SSH 主機。
2. `pnpm dev:desktop`：同時啟動 Vite 與 Electron；UI 改動熱更新，`apps/desktop/src` 的 main/preload 改動才需要重啟。
3. Commit 前跑：`pnpm lint && pnpm typecheck && pnpm test`。
4. Desktop 自動驗收：`pnpm --filter @cozypad/desktop smoke`。

平常使用（非開發）：雙擊根目錄 `CozyPad.bat`（真 SSH）或 `CozyPad-Demo.bat`（假主機）。

## 2. SSH 密碼與 Key 測試

在連線管理新增 profile，選擇「密碼」或「SSH Key」。Private key 可貼上或選檔；加密 key 另填 passphrase。
第一次連線要核對 OpenSSH `SHA256:` host-key fingerprint；若 fingerprint 變更，先在主機端確認原因，不要直接接受。

關閉「以 OS 安全儲存保留驗證資料」時，credential 只保留到 app 結束，但同次執行期間仍可用於斷線重連。
Desktop 的完整 profile 與 host trust 由 Electron `safeStorage` 加密；舊版明文儲存會在首次啟動時自動原子遷移。

## 3. Signed Desktop package

正式 Windows 安裝檔必須提供 code-signing certificate：

```powershell
$env:CSC_LINK = "<certificate path or encoded certificate>"
$env:CSC_KEY_PASSWORD = "<CI or local secret>"
pnpm.cmd --filter @cozypad/app build
pnpm.cmd --filter @cozypad/desktop package
```

`package:unsigned` 預設只供本機驗證。若產品負責人明確核准延後原型簽章，內部 prerelease 的檔名與 release notes 必須清楚標示 `Internal`、unsigned 與 SHA-256；不得當作正式或 latest release。

## 4. Flutter 指令對照

| Flutter | 本專案 |
| --- | --- |
| `flutter doctor` | `pnpm install` 成功 |
| hot reload（按 r） | 自動（Vite HMR，存檔即生效） |
| `flutter run`（桌面） | `pnpm dev:desktop` |
| `flutter test` | `pnpm test` |
| `flutter analyze` | `pnpm lint && pnpm typecheck` |
