# CozyPad4

CozyPad4 是基於 CozyPad-0.2.9-alpha 持續演進的遠端工作站介面，目標是把 SSH 終端機、遠端檔案瀏覽、伺服器監控，以及 Claude / Codex / agy / bailian 等 coding agent 統一放在同一個可切換的工作環境中。

## 專案定位

| 項目 | 說明 |
| --- | --- |
| 核心用途 | 透過 SSH 連到遠端 Linux 伺服器，讓使用者可以在瀏覽器、桌面端或手機端操作遠端工作環境。 |
| Agent 設計 | Claude、Codex、agy 都以遠端伺服器為工作目標，避免把任務錯誤執行在本機電腦。 |
| 工作保存 | 遠端任務預期綁定 SSH server 與遠端工作目錄，讓使用者切換頁面或重新開啟後仍能接續工作。 |
| 介面方向 | CozyPad4 以 CozyPad-0.2.9-alpha 的穩定 SSH / file / monitor 基礎為主，融合 v2 Web 的 agent 對話體驗。 |

## 主要功能

| 功能區 | 目前方向 | 重點 |
| --- | --- | --- |
| SSH workspace | 遠端終端與 server 管理 | 支援多台 SSH server、server 下拉選擇、連線狀態顯示與常用指令。 |
| Files | 遠端檔案瀏覽 | 參考 v1 file viewer，可瀏覽 server 檔案，並用彈出式視窗預覽文字、Markdown、PDF、圖片。 |
| Monitor | 系統管理預覽 | 顯示可連線伺服器的 CPU、RAM、Disk、GPU 等狀態，避免無限制重複 SSH 嘗試。 |
| Agents | Claude / Codex / agy 對話 | 採用類似 Claude 的 session list、對話 timeline、工具卡片、diff 區塊與底部輸入列。 |
| Security | 帳號密碼與 2FA | CozyPad 自己保留帳密與 TOTP 2FA，並建議前層搭配 Cloudflare Access。 |

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
