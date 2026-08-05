# CozyPad 功能文件

CozyPad 是一套用於遠端伺服器工作的 Web / Desktop 管理介面，整合 SSH server、Agent CLI、檔案瀏覽、終端機、研究流程圖、Markdown 彙整、Work 任務紀錄與資源監控。

## 安裝教學

| 步驟 | 指令或動作 | 說明 |
| --- | --- | --- |
| 1 | 安裝 Node.js LTS | 建議使用目前 LTS 版本，並啟用 Corepack。 |
| 2 | `corepack enable` | 啟用 pnpm 管理。 |
| 3 | `corepack pnpm install` | 安裝專案依賴。 |
| 4 | `corepack pnpm dev` | 啟動前端開發頁面。 |
| 5 | `corepack pnpm dev:v2-web` | 同時啟動前端與 legacy SSH API。 |
| 6 | `corepack pnpm typecheck` | 檢查 TypeScript 型別。 |
| 7 | `corepack pnpm build` | 建置正式版本。 |

## 功能總覽

| 模組 | 目前能力 |
| --- | --- |
| Agents | 支援 Codex、Claude、agy、bailian 分頁；可綁定 SSH server 執行遠端 CLI 工作。 |
| Codex | 支援遠端 Codex CLI 工作分頁、Markdown 對話輸出、圖片拖曳或貼上、Work 任務紀錄。 |
| Claude | 支援遠端 Claude CLI 對話介面，並保留工作紀錄與使用狀態。 |
| agy | 支援遠端 agy CLI 檢查、執行、對話式回覆與 Work 顯示。 |
| bailian | 新增 bailian CLI 分頁，支援 txt key 載入與遠端執行。 |
| Terminal | 使用既有 SSH server 清單連線，支援 localhost 模式與遠端 shell。 |
| Files | 支援 SSH server 檔案瀏覽、預覽、右鍵刪除、重新命名與新增資料夾。 |
| Research | 支援可拖曳流程圖、節點連線、MD.md、MD.mix 與送 91 分析。 |
| Work | 彙整 Codex / Claude / agy / bailian 任務，顯示 run、status、duration、seed、start date、end date。 |
| Markdown | 支援多個 md / markdown / txt 檔案拖曳匯入與整理結果預覽。 |
| Monitor | 以單機一頁方式顯示 CPU、RAM、DISK、GPU，右側 drawer 顯示 online server。 |

## 近期更新

| 日期 | 模組 | 更新內容 |
| --- | --- | --- |
| 2026-08-05 | Agents | 新增 `bailian` 分頁，位置在 `agy` 右側。 |
| 2026-08-05 | bailian | 新增 `新增 key` 按鈕，只接受 `.txt` key 檔案。 |
| 2026-08-05 | bailian | key 只保留在目前頁面記憶體，不顯示、不寫入 localStorage、不存檔、不放入 Work 紀錄。 |
| 2026-08-05 | bailian | 新增 `/api/ssh/servers/:id/bailian-status` 與 `/api/ssh/bailian/run`。 |
| 2026-08-05 | bailian | 送出 prompt 時，key 只在該次 request 中傳入後端，後端以環境變數提供給 CLI。 |
| 2026-08-05 | Work | Work 新增 bailian 任務來源，刪除任務後會同步清除對應紀錄。 |
| 2026-08-05 | Agent SSH | agy / bailian 都遵守 transport failure cooldown，不自動反覆重連 SSH。 |
| 2026-08-05 | Docs | README 重新整理為乾淨 UTF-8 中文內容，移除亂碼。 |
| 2026-08-04 | Research | 新增可拖曳流程圖、節點刪除、綠色連線、箭頭方向與多方向連接點。 |
| 2026-08-04 | Research | 新增 `default analysis diagram` 與 `mix analysis diagram`。 |
| 2026-08-04 | MD.md | 接收單一流程圖分析結果，作為訓練排程 prompt。 |
| 2026-08-04 | MD.mix | 接收五份流程圖 feedback：模型建議、超參數建議、資料前處理建議、模型評估建議、整體建議。 |
| 2026-08-04 | Flowchart API | 支援 batch flowchart markdown 分析，每批 2 到 3 個檔案，依空閒 GPU 判斷。 |
| 2026-08-04 | Start Training | `Start Training` 改成內嵌輸入，不使用彈出式視窗，送出後產生 Work 任務。 |
| 2026-08-04 | Monitor | 改為右側觸碰 drawer，online server 才顯示於 drawer。 |
| 2026-08-03 | Files | 補上圖片、PDF、Markdown、文字檔、MP3、MP4 預覽流程。 |
| 2026-08-03 | Research Table | Research / Work 欄位改為 run、status、duration、seed、start date、end date。 |
| 2026-08-02 | 整合 | 以 CozyPad-0.2.9-alpha 為基礎，融合 v1 SSH 功能與 v2 Web 介面精神。 |

## bailian key 安全設計

| 項目 | 行為 |
| --- | --- |
| 載入方式 | 使用 `新增 key` 按鈕選擇 `.txt` 檔案。 |
| 前端保存 | 只保留在 React state；重新整理頁面後消失。 |
| 顯示方式 | 只顯示 `loaded` 或檔名，不顯示 key 內容。 |
| 本地儲存 | 不寫入 localStorage、sessionStorage 或工作紀錄。 |
| 後端傳遞 | 只在該次 `/api/ssh/bailian/run` request 中使用。 |
| 遠端執行 | 以環境變數提供給 bailian CLI，不放在 shell command argv。 |

## 截圖

| 功能 | 圖片 |
| --- | --- |
| Research Diagram | ![Research Diagram](docs/screenshots/feature-research-diagram.png) |
| Codex Agent | ![Codex Agent](docs/screenshots/feature-agents-codex.png) |
| Research MD.mix | ![Research MD.mix](docs/screenshots/feature-research-mdmix.png) |
| Agents | ![Agents](docs/screenshots/feature-agents.png) |
| Files | ![Files](docs/screenshots/feature-files.png) |
| Terminal | ![Terminal](docs/screenshots/feature-terminal.png) |
| Monitor | ![Monitor](docs/screenshots/feature-monitor.png) |

## 測試資料

| 路徑 | 用途 |
| --- | --- |
| `docs/examples/markdown-summary/notes/` | Markdown 彙整測試筆記。 |
| `docs/examples/markdown-summary/messy-proof-notes/` | 模擬雜亂研究筆記與待辦事項。 |
| `docs/examples/markdown-summary/fake-model-logs/` | 模型分數、ablation、scoreboard 與訓練 log 測試資料。 |

## Release 打包原則

| 類型 | 處理方式 |
| --- | --- |
| `.env` / `.env.*` | 不放入 release。 |
| SSH key / token / API key | 不放入 release。 |
| `data/` / `.run-logs/` | 不放入 release。 |
| `node_modules/` / `dist/` / build cache | 不放入 release，由使用者自行安裝與建置。 |
