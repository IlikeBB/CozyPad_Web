# CozyPad 架構筆記

## 目標

CozyPad 的目標是提供一個可以透過瀏覽器操作遠端 SSH server 的工作平台。使用者可以在同一個介面中切換 Terminal、Files、Monitor、Agents、Research 與 Markdown 等工作區。

## 目前主要模組

| 模組 | 功能 | 狀態 |
| --- | --- | --- |
| Login | 帳號密碼與 TOTP 2FA | 已完成基本流程 |
| Terminal | 連線到已匯入的 SSH server | 可用，但需要避免頻繁重連 |
| Files | 遠端檔案瀏覽與預覽 | 已支援文字、Markdown、PDF、圖片與影音 |
| Monitor | 遠端資源監控 | 參考 v1 做 real-time 資源顯示 |
| Codex | 遠端 CLI 工作流程 | 改為使用 server 端 Codex |
| Markdown | 筆記彙整入口 | 已建立頁面與上傳區 |

## 設計原則

1. SSH 連線應盡量復用，不要每次刷新頁面都重新登入。
2. 每個 CozyPad 使用者只能看到自己的 SSH server 設定。
3. 敏感操作，例如刪除、move、domain 更新，需要二次確認。
4. Codex 和 Claude 類 agent 應該在遠端 server 上執行，而不是使用本地端 CLI。

## 待確認

- Markdown 彙整是否要保存每次任務紀錄。
- 91 server 的 Qwen3-14B 是否要常駐模型服務。
- 大量 Markdown 檔案是否需要建立背景佇列。
