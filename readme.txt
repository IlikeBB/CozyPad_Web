# CozyPad Web

CozyPad Web 是 CozyPad3 的公開預覽頁與輕量文件倉庫。
目前方向是把 SSH 終端、遠端檔案瀏覽、伺服器資源監控，以及 Claude / Codex / agy 類 agent 工作區整合到同一個 Web 介面。

## 安裝教學

| 步驟 | 操作 | 說明 |
| --- | --- | --- |
| 1 | 下載 Release .zip | 從 GitHub Releases 下載最新的 CozyPad3 public preview zip。 |
| 2 | 解壓縮專案 | 將 zip 解到本機工作目錄，進入 CozyPad3 資料夾。 |
| 3 | 安裝 Node.js LTS | 建議使用 Node.js LTS，並確認 corepack 可用。 |
| 4 | 安裝依賴 | 執行 corepack pnpm install。 |
| 5 | 建立本機設定 | 需要連接 SSH / domain / agent 時，依照 legacy-v2.env.example 建立自己的 .env。 |
| 6 | 啟動開發模式 | 一般前端預覽執行 corepack pnpm dev；需要 v2 SSH API 時執行 corepack pnpm dev:v2-web。 |
| 7 | 檢查專案 | 執行 corepack pnpm typecheck，必要時再執行 corepack pnpm lint / corepack pnpm build。 |

功能截圖保留在 docs/screenshots/，README 不再用功能預覽表格展開。

## 功能總覽

| 模組 | 說明 |
| --- | --- |
| SSH Workspace | 管理多台 SSH server、終端分頁、常用指令與遠端工作狀態。 |
| Files | 以 SSH server 為目標瀏覽遠端檔案，並提供檔案預覽與基本操作。 |
| Monitor | 透過既有 SSH 設定讀取伺服器資源狀態；避免高頻率重複登入。 |
| Agents | Claude、Codex、agy 等 agent 以遠端 server / cwd 為工作目標。 |
| Markdown | 上傳多份 Markdown / text 筆記，交由後端彙整成可閱讀的 Markdown summary。 |
| Security | 登入與高風險操作採分層確認；私密設定留在本機環境，不放入 GitHub。 |

## 近期更新補充

| 日期 | 模組 | 更新內容 |
| --- | --- | --- |
| 2026-08-03 | Markdown | 新增 Markdown 筆記彙整工作區，可拖入多個 .md / .markdown / .txt 檔案，彙整結果以 Markdown 排版呈現。 |
| 2026-08-03 | Markdown UI | 上傳檔案與 Summary result 改為由左到右排列；彙整中會暫時隱藏上傳區，完成後再顯示。 |
| 2026-08-03 | 測試資料 | 補上 Markdown 筆記與假模型訓練 log 測試資料，方便驗證彙整結果是否真的被整理過。 |

## 測試資料

| 位置 | 用途 |
| --- | --- |
| docs/examples/markdown-summary/notes/ | CozyPad 功能筆記、會議紀錄與待辦，用於測試多檔筆記彙整。 |
| docs/examples/markdown-summary/messy-proof-notes/ | 故意保留重複、順序混亂與口語內容，用於確認 summary 是否有重新整理。 |
| docs/examples/markdown-summary/fake-model-logs/ | 假模型分數、訓練 log、ablation 與錯誤分析，用於測試研究紀錄整理。 |

## 快速啟動摘要

| 操作 | 指令 |
| --- | --- |
| 安裝套件 | corepack pnpm install |
| 啟動 Web dev server | corepack pnpm dev |
| 型別檢查 | corepack pnpm typecheck |
| Lint | corepack pnpm lint |
| Build | corepack pnpm build |

## Release 包內容

Release 附件採用 .zip。打包時會排除本機環境設定、資料目錄、執行紀錄、依賴目錄、建置輸出、快取、金鑰與憑證類檔案。

## 注意事項

| 項目 | 說明 |
| --- | --- |
| GitHub README | README.md 為 GitHub 首頁；readme.txt 保留為純文字備份。 |
| 私密資料 | 若要部署，請自行建立本機 .env 與憑證檔，不要提交到 GitHub。 |
| 預覽截圖 | 截圖已移除登入頁與敏感連線資訊，只保留功能畫面。 |
