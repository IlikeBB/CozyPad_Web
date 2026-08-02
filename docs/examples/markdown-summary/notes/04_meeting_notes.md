# 會議紀錄：CozyPad v3 功能整合

## 時間

2026-08-03

## 主題

討論 CozyPad v3 是否能把 v1 的 SSH 功能、v2 Web 的操作精神，以及新的 Markdown 筆記彙整整合在同一個介面中。

## 討論重點

- v3 目前以 CozyPad-0.2.9-alpha 作為基礎。
- v2 Web 的頁面暫時不直接顯示，但設計精神會融合進 v3。
- SSH server 新增、檔案瀏覽、Terminal、Monitor 都要保留。
- Codex 必須使用遠端 server 端 CLI，不要使用本地 Windows 的 Codex。
- Markdown 頁面先以 91 server 和 Qwen3-14B 為主。

## 決策

| 項目 | 決策 |
| --- | --- |
| v2 Web | 暫時隱藏 |
| Codex | 改走遠端 server |
| Files | 保留 v1 遠端瀏覽能力 |
| Markdown | 新增獨立左側按鈕 |
| Cloudflare | 先使用 Managed Challenge |

## 待辦

- 測試 Markdown 上傳後是否能呼叫遠端 Python。
- 確認 91 server 的模型啟動流程。
- 補 README 的最新架構說明。
- 針對 release zip 避免包含安全資訊。
