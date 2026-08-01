# CozyPad Web

CozyPad Web 是 CozyPad3 的公開預覽頁與輕量文件倉庫。  
目前方向是把 SSH 終端、遠端檔案瀏覽、伺服器資源監控，以及 Claude / Codex / agy 類 agent 工作區整合到同一個 Web 介面。

> 此倉庫只放公開 README、功能截圖與 Release 附件；不提交 `.env`、SSH key、token、log、data 或任何私有設定。

## 現有功能預覽

| 畫面 | 截圖 | 重點 |
| --- | --- | --- |
| Agents / Codex | ![Agents / Codex](docs/screenshots/feature-agents.png) | 類 Claude 的 agent 工作區：左側任務列表、中間對話 timeline、右側上下文與工具狀態。 |
| Terminal | ![Terminal](docs/screenshots/feature-terminal.png) | 連線後可開啟多分頁終端，並保留常用指令與快速執行按鈕。 |
| Files | ![Files](docs/screenshots/feature-files.png) | 遠端檔案瀏覽入口，規劃支援文字、Markdown、PDF、圖片等彈出式預覽。 |
| Monitor | ![Monitor](docs/screenshots/feature-monitor.png) | 參考 v1 的伺服器資源檢測，顯示 CPU、RAM、Disk、GPU 與 GPU process 狀態。 |

## 功能總覽

| 模組 | 說明 |
| --- | --- |
| SSH Workspace | 管理多台 SSH server、終端分頁、常用指令與遠端工作狀態。 |
| Files | 以 SSH server 為目標瀏覽遠端檔案，並提供檔案預覽與基本操作。 |
| Monitor | 透過既有 SSH 設定讀取伺服器資源狀態；避免高頻率重複登入。 |
| Agents | Claude、Codex、agy 等 agent 以遠端 server / cwd 為工作目標。 |
| Security | 登入與高風險操作採分層確認；私密設定留在本機環境，不放入 GitHub。 |

## 快速啟動摘要

| 操作 | 指令 |
| --- | --- |
| 安裝套件 | `corepack pnpm install` |
| 啟動 Web dev server | `corepack pnpm dev` |
| 型別檢查 | `corepack pnpm typecheck` |
| Lint | `corepack pnpm lint` |
| Build | `corepack pnpm build` |

公開預覽：<https://cozypad.modoubletw.com/>

## Release 包內容

Release 附件採用 `.zip`。打包時會排除：

| 排除項目 | 原因 |
| --- | --- |
| `.env` / `.env.*` | 避免公開本機環境變數與部署設定。 |
| `data/` / `.run-logs/` | 避免公開使用者資料、登入紀錄與執行紀錄。 |
| `node_modules/` / `dist/` / build cache | 保持 zip 輕量，依賴可用 `pnpm install` 重建。 |
| 金鑰與憑證類檔案 | 避免公開任何可用於存取服務或主機的私密資料。 |

## 注意事項

| 項目 | 說明 |
| --- | --- |
| GitHub README | `README.md` 為 GitHub 首頁；`readme.txt` 保留為純文字備份。 |
| 私密資料 | 若要部署，請自行建立本機 `.env` 與憑證檔，不要提交到 GitHub。 |
| 預覽截圖 | 截圖已移除登入頁與敏感連線資訊，只保留功能畫面。 |
