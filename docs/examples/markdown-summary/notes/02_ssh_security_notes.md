# SSH 安全性筆記

## 背景

CozyPad 會管理多台 SSH server。由於部分學校或實驗室 server 會把短時間內大量失敗登入視為攻擊，因此系統必須避免自動狂重試。

## 已討論的安全策略

- 新增 server 時可以用密碼完成初次 key 安裝。
- 安裝 key 後，之後應改用 key 登入，不保存明文密碼。
- SSH 失敗後不要自動頻繁重連。
- SSH 工作區的重新整理按鈕需要冷卻時間，目前目標是每 1 分鐘只能按一次。
- 不同帳號的 SSH 設定需要分開保存，不能共用 admin 的結果。

## Cloudflare 層級

目前外部連線前面可以使用 Cloudflare 的 Managed Challenge，降低機器人和掃描流量直接碰到 CozyPad 的機會。若未來需要更嚴格保護，可以再加 Cloudflare Access，但目前希望先維持免費且較輕量的驗證方式。

## 風險

1. SSH key 管理若混用使用者資料夾，可能造成權限外洩。
2. 終端與檔案瀏覽若都建立獨立 SSH，可能讓遠端誤判為攻擊。
3. Codex 任務若沒有工作目錄隔離，可能在錯誤 server 或錯誤 path 執行。

## 建議

- 以 serverId + userId 做 SSH session cache key。
- 成功連線後盡量保持同一條通道。
- 針對不可逆操作加入 confirm dialog。
- Log 中不要顯示 local key path、token、private config path。
