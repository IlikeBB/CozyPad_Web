CozyPad Web
===========

CozyPad Web 是一個用來管理遠端 SSH 工作環境的網頁工作台。
目前版本以 CozyPad-0.2.9-alpha 的初始架構為主，並把既有 v2 網頁版頁面以獨立工作區方式整合進來。

GitHub 首頁請以 README.md 為主，因為 README.md 可以正常顯示表格與網頁截圖。

主要內容
--------

| 項目 | 目前狀態 | 說明 |
| --- | --- | --- |
| 主架構 | CozyPad-0.2.9-alpha | 保留 alpha 版 workspace / sidebar / bridge 架構 |
| v2 Web 頁面 | 已整合 | 以 V2 Web 工作區掛載 |
| Legacy API | 已接入 | 透過 /api proxy 轉到本機 legacy API server |
| 截圖文件 | 已整理 | docs/screenshots 內含目前網頁截圖 |
| 驗證狀態 | 通過 | lint、typecheck、test、build 均已通過 |

截圖
----

| 畫面 | 路徑 |
| --- | --- |
| CozyPad alpha 主介面 | docs/screenshots/cozypad3-alpha-main.png |
| V2 Web 工作區 | docs/screenshots/cozypad3-v2-web.png |

快速啟動
--------

| 目的 | 指令 |
| --- | --- |
| 安裝依賴 | corepack pnpm install |
| 啟動 alpha web | corepack pnpm dev |
| 啟動 alpha + v2 web API | corepack pnpm dev:v2-web |
| 型別檢查 | corepack pnpm typecheck |
| 測試 | corepack pnpm test |
| 打包 | corepack pnpm build |

安全注意事項
------------

| 類別 | 設計方向 |
| --- | --- |
| 登入防護 | 建議使用 Cloudflare Access 作為外層保護，再搭配 CozyPad 自身帳密與 TOTP 2FA |
| SSH 憑證 | 新增 server 時使用密碼安裝 key，之後以 key 連線 |
| SSH 重試 | 失敗後不自動高頻率重試，避免被遠端主機誤判為攻擊 |
| 高風險操作 | 檔案刪除、move、domain 更新等操作應加入二次確認 |
| 私密資料 | 不提交 .env、SSH key、Cloudflare token 或任何私密設定到 GitHub |

