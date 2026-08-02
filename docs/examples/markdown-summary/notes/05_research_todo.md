# Research 與任務紀錄待辦

## 目標

Research 頁面應該可以顯示 Codex 或 Claude 執行過的任務，方便追蹤研究與工程工作狀態。

## 欄位設計

| 欄位 | 說明 |
| --- | --- |
| run | 任務名稱，格式為 codex-1234 或 claude-5678 |
| status | running、completed、failed |
| duration | 任務花費時間 |
| seed | 四位數或任務 seed |
| start date | 開始時間 |
| end date | 結束時間 |

## 顯示規則

- run 名稱用 `codex` 或 `claude` 開頭。
- 後方接四位亂碼數字。
- 不顯示本地 PowerShell 啟動命令。
- Codex 可以正常使用時，不應被錯誤標成 failed。

## 待辦清單

- [ ] 重新檢查 status 判斷邏輯。
- [ ] 區分任務失敗與 SSH 連線暫時中斷。
- [ ] 將任務歷史寫入每個使用者自己的資料區。
- [ ] 支援每頁最多 20 筆紀錄。
- [ ] 支援依 server 過濾任務。
