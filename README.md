# CozyPad Web

目前方向是把 SSH 終端、遠端檔案瀏覽、伺服器資源監控，以及 Claude / Codex / agy 類 agent 工作區整合到同一個 Web 介面。

## 近期更新

| 日期 | 模組 | 更新內容 |
| --- | --- | --- |
| 2026-08-02 | 專案整合 | 以 `CozyPad-0.2.9-alpha` 為基底建立 v3，並把 v2 Web 的版面精神融合進 v3；公開展示先保留 v3 主介面，v2 Web 暫時隱藏。 |
| 2026-08-02 | 登入與安全 | 保留 CozyPad 自有帳號密碼登入，加入 TOTP 2FA 流程；每個帳號的 SSH server 紀錄分開保存，避免互相看到設定。 |
| 2026-08-02 | SSH 管理 | 新增 server 改為先通過密碼驗證再建構可直連設定；後續以 key 連線為主，避免保存明文密碼。SSH 失敗不自動高頻重試，重新整理也加入冷卻限制。 |
| 2026-08-02 | Terminal | Terminal 已改為讀取匯入的 SSH server 清單，可依 server 開啟分頁終端，並盡量維持同一條 SSH 通道，降低被遠端主機判定為重複登入的風險。 |
| 2026-08-02 | Files | 檔案瀏覽改為連到對應 SSH server；支援遠端目錄瀏覽、文字 / Markdown / PDF / 圖片預覽，並補上右鍵刪除、重新命名，以及空白處新增資料夾。 |
| 2026-08-02 | Agents | Codex / Claude 介面改成接近 Claude 的工作區：左側 sessions、中間對話 timeline、右側 context。Codex 以遠端 server 為工作目標，文字回覆支援 Markdown，技術 log 可收合顯示。 |
| 2026-08-02 | Research | Codex / Claude 任務會同步出現在 Research；欄位改為 `run`、`status`、`duration`、`seed`、`start date`、`end date`，run 名稱以 `codex` / `claude` 加 4 位數識別。 |
| 2026-08-02 | Monitor | Monitor 參考 v1 的伺服器資源檢測，重點顯示 CPU、RAM、所有硬碟、GPU 與 GPU process；硬碟或 GPU 過多時改用可捲動區塊。 |
| 2026-07-29 | Domain / DDNS | Domain 管理限定管理員可見，並讓 DDNS agent 可選擇要更新的 record，例如 CozyPad domain；高風險更新動作保留二次確認。 |
| 2026-08-03 | Markdown | 新增 Markdown 筆記彙整工作區，可拖入多個 `.md` / `.markdown` / `.txt` 檔案，彙整結果以 Markdown 排版呈現。 |
| 2026-08-03 | Markdown UI | 上傳檔案與 Summary result 改為由左到右排列；彙整中會暫時隱藏上傳區，完成後再顯示。 |
| 2026-08-03 | 測試資料 | 補上 Markdown 筆記與假模型訓練 log 測試資料，方便驗證彙整結果是否真的被整理過。 |
| 2026-08-04 | Research Flowchart | Research 改成可編輯流程圖畫布，支援拖曳方塊、四向連接點、綠色方向箭頭、右鍵新增方塊與刪除連線。 |
| 2026-08-04 | Research / MD.md | 流程圖可送到遠端分析後回填 `MD.md`；`Start Training` 改為頁面內嵌 prompt 表單，不再使用彈出式視窗。 |
| 2026-08-04 | Work / Codex | `Start Training` 會建立訓練與監控任務並同步到 Work；Codex 回覆支援 Markdown，內部狀態與連線噪音改為收合或隱藏。 |

## 安裝教學

| 步驟 | 操作 | 說明 |
| --- | --- | --- |
| 1 | 下載 Release `.zip` | 從 GitHub Releases 下載最新的 CozyPad3 public preview zip。 |
| 2 | 解壓縮專案 | 將 zip 解到本機工作目錄，進入 `CozyPad3` 資料夾。 |
| 3 | 安裝 Node.js LTS | 建議使用 Node.js LTS，並確認 `corepack` 可用。 |
| 4 | 安裝依賴 | 執行 `corepack pnpm install`。 |
| 5 | 建立本機設定 | 需要連接 SSH / domain / agent 時，依照 `legacy-v2.env.example` 建立自己的 `.env`。 |
| 6 | 啟動開發模式 | 一般前端預覽執行 `corepack pnpm dev`；需要 v2 SSH API 時執行 `corepack pnpm dev:v2-web`。 |
| 7 | 檢查專案 | 執行 `corepack pnpm typecheck`，必要時再執行 `corepack pnpm lint` / `corepack pnpm build`。 |

功能截圖保留在 `docs/screenshots/`，README 不再用功能預覽表格展開。

## 功能總覽

| 模組 | 說明 |
| --- | --- |
| SSH Workspace | 管理多台 SSH server、終端分頁、常用指令與遠端工作狀態。 |
| Files | 以 SSH server 為目標瀏覽遠端檔案，並提供檔案預覽與基本操作。 |
| Monitor | 透過既有 SSH 設定讀取伺服器資源狀態；避免高頻率重複登入。 |
| Agents | Claude、Codex、agy 等 agent 以遠端 server / cwd 為工作目標。 |
| Markdown | 上傳多份 Markdown / text 筆記，交由後端彙整成可閱讀的 Markdown summary。 |
| Security | 登入與高風險操作採分層確認；私密設定留在本機環境，不放入 GitHub。 |

## 測試資料

| 位置 | 用途 |
| --- | --- |
| `docs/examples/markdown-summary/notes/` | CozyPad 功能筆記、會議紀錄與待辦，用於測試多檔筆記彙整。 |
| `docs/examples/markdown-summary/messy-proof-notes/` | 故意保留重複、順序混亂與口語內容，用於確認 summary 是否有重新整理。 |
| `docs/examples/markdown-summary/fake-model-logs/` | 假模型分數、訓練 log、ablation 與錯誤分析，用於測試研究紀錄整理。 |

## 快速啟動摘要

| 操作 | 指令 |
| --- | --- |
| 安裝套件 | `corepack pnpm install` |
| 啟動 Web dev server | `corepack pnpm dev` |
| 型別檢查 | `corepack pnpm typecheck` |
| Lint | `corepack pnpm lint` |
| Build | `corepack pnpm build` |

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
