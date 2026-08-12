# CozyPad4

CozyPad4 是基於 CozyPad-0.2.9-alpha 持續演進的遠端工作站介面，目標是把 SSH 終端機、遠端檔案瀏覽、伺服器監控，以及 Claude / Codex / agy / bailian 等 coding agent 統一放在同一個可切換的工作環境中。

## 專案定位

| 項目 | 說明 |
| --- | --- |
| 核心用途 | 透過 SSH 連到遠端 Linux 伺服器，讓使用者可以在瀏覽器、桌面端或手機端操作遠端工作環境。 |
| Agent 設計 | Claude、Codex、agy 都以遠端伺服器為工作目標，避免把任務錯誤執行在本機電腦。 |
| 工作保存 | 遠端任務預期綁定 SSH server 與遠端工作目錄，讓使用者切換頁面或重新開啟後仍能接續工作。 |
| 介面方向 | CozyPad4 以 CozyPad-0.2.9-alpha 的穩定 SSH / file / monitor 基礎為主，融合 v2 Web 的 agent 對話體驗。 |

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

| 功能區 | 目前狀態 | 重點 |
| --- | --- | --- |
| SSH server 管理 | 可用 | 新增、刪除、下拉選擇 server；支援 localhost 與遠端 SSH profile；已連線 server 可供 Agents / Terminal / Files / Monitor 共用。 |
| Terminal | 可用 | xterm.js 多分頁終端、常用指令面板、右鍵複製貼上、手機 Termux 式按鍵列；未按 Connect 時不會自動啟動遠端 SSH。 |
| Files | 可用 | 遠端資料夾瀏覽、上一層導覽、右鍵刪除／重新命名、空白處新增資料夾、複製路徑；支援文字、Markdown、PDF、圖片與影音檔案預覽。 |
| Agents | 可用 | Codex、agy、Bailian 遠端任務介面；支援工作清單、Markdown 對話、工具／狀態泡泡、Stop、右鍵編輯已送出訊息並停止後重新執行。 |
| Research Lab | 可用 | 多 flowchart tab、可拖曳 node、綠色方向連線、右鍵新增 node、點 node 查看 Markdown；支援 agent draw、節點回饋、分析 Diagram、Start Training 與 Work 任務串接。 |
| Work | 可用 | 顯示 Research / Agents 建立的任務狀態，可從 run 連回對應任務，刪除後會清掉舊紀錄。 |
| device Monitor | 可用 | 以 SSH live monitor 讀取 server CPU、RAM、Disk、GPU / GPU process 狀態，支援 pause、refresh、real time 與 online server drawer。 |
| Public / domain 工具 | 可用 | Cloudflare / DDNS 狀態檢查、API / tunnel / public URL health 顯示，輔助判斷 403、502、1033 等對外連線問題。 |
| 安全流程 | 可用 | CozyPad 帳密 + TOTP 2FA、Cloudflare edge/security fallback、危險操作二次確認、避免 SSH 失敗後自動狂重試。 |

> Claude 相關服務目前已隱藏／暫停，不列入目前可用功能清單。

## 安裝教學

| 步驟 | 指令 / 操作 |
| --- | --- |
| 1. 安裝 Node.js LTS | 建議使用目前 LTS 版本。 |
| 2. 啟用 pnpm | `corepack enable` |
| 3. 安裝套件 | `corepack pnpm install` |
| 4. 啟動 Web 開發版 | `corepack pnpm dev` |
| 5. 啟動 API | `corepack pnpm legacy-v2:api` |
| 6. 型別檢查 | `corepack pnpm typecheck` |

## Agent 介面規劃

| 元件 | Claude | Codex |
| --- | --- | --- |
| Session / Task 列表 | 左側顯示不同任務，可搜尋與切換。 | 左側顯示 Codex 工作，可依遠端 server 與目錄保存。 |
| 對話排列 | 使用者訊息與 agent 回覆分流顯示，工具輸出用卡片呈現。 | 使用者在右側，Codex 在左側；長輸出折疊，指令、程式碼、diff 用不同區塊顏色呈現。 |
| 遠端綁定 | 綁定 SSH server、project、cwd、tmux session。 | 預期每個 Codex 任務都綁定遠端 SSH server 與工作目錄。 |
| 輸入列 | 底部固定輸入，Enter 送出，Shift+Enter 換行。 | 底部固定輸入，支援送出需求與新增工作。 |

## 安全設計重點

| 項目 | 做法 |
| --- | --- |
| 登入保護 | CozyPad 帳號密碼加上 TOTP 2FA。 |
| 外部存取 | 建議由 Cloudflare Access / WAF 作為第一層入口保護。 |
| SSH 憑證 | 新增 server 時用密碼安裝 key，之後優先使用 key，不保存明文密碼。 |
| 高風險操作 | 檔案刪除、move、domain 更新等操作需要二次確認。 |
| SSH 重試 | 連線失敗後不自動狂重試，避免被遠端主機誤判為攻擊。 |

## 開發與啟動

| 操作 | 指令 |
| --- | --- |
| 安裝套件 | `corepack pnpm install` |
| 啟動 Web dev server | `corepack pnpm dev` |
| 型別檢查 | `corepack pnpm typecheck` |
| Lint | `corepack pnpm lint` |
