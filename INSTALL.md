# 安裝教學（5 分鐘）

在瀏覽器裡對任何網頁「指著某個地方留言」，留言連同截圖直接送進 Claude Code。
只支援 macOS + Chrome。

## 0. 事前準備

- 已經在用 **Claude Code**（終端機輸入 `claude` 會啟動）。
- 安裝 **Node.js 20 以上**：到 <https://nodejs.org> 下載「LTS」版，一路下一步。
  裝好後在終端機輸入 `node -v`，看到 `v20` 或更高就可以。
- **Google Chrome**。

## 1. 解壓縮，放到固定位置

把 zip 解壓縮成一個資料夾，放到你**不會再搬動**的地方，例如：

```
~/local-artifact
```

（之後 Claude Code 會直接從這個資料夾執行，搬走就壞了。）

## 2. 裝進 Claude Code

打開終端機，貼上這兩行（路徑改成你放的位置）：

```bash
claude plugin marketplace add ~/local-artifact
claude plugin install local-artifact@local-artifact
```

## 3. 裝 Chrome 擴充功能（一定要）

1. Chrome 網址列輸入 `chrome://extensions`
2. 右上角打開 **開發人員模式**
3. 按 **載入未封裝項目**，選 `~/local-artifact/extension` 這個資料夾

Chrome 會說這個擴充功能「可以讀取所有網站」——它需要這個權限才能在任何網頁上放留言按鈕和截圖。

## 4. 開始用

1. 在你的專案資料夾裡啟動 Claude Code（`claude`），輸入：

   ```
   /connect
   ```

   看到這兩行就是成功：

   ```
   extension  seen 5s ago
     monitor listening
   ```

2. 在 Chrome 打開任何網頁（本機開發站、正式站都可以）。
   畫面**右邊邊緣**有一個半藏著的 💬 按鈕，滑鼠靠近會滑出來。
3. 按下 💬，點網頁上的任何東西，打字，按 **Send**。
   Claude Code 那邊會立刻收到留言、位置和截圖。

之後要換另一個專案，就到那個專案的 Claude Code 裡再打一次 `/connect`；留言會送到**最後一個**打 `/connect` 的 session。

## 5.（選用）把留言貼到 Slack

1. 點 Chrome 右上角這個擴充功能的圖示，在 **Slack** 那一列按 **連線**。
2. 瀏覽器會跳出 Slack 授權頁，按允許。回到選單會看到你的名字和 workspace。

之後留言面板上多一個 **Slack** 按鈕，可以把留言（含截圖）用你自己的名義貼到頻道或私訊。
要斷開就回同一個選單按 **中斷連線**。

## 出問題時看這裡

| 看到什麼 | 怎麼辦 |
|---|---|
| `/connect` 印出 `extension  NOT SEEN` | 第 3 步沒做，或擴充功能被停用。到 `chrome://extensions` 確認它開著，再打一次 `/connect` |
| 網頁上沒有 💬 按鈕 | 先在 Claude Code 打 `/connect`，再**重新整理**那個網頁 |
| `monitor NOT ATTACHED` | 關掉 Claude Code 重開一次，再 `/connect` |
| 改過 `extension/` 裡的檔案後怪怪的 | 到 `chrome://extensions` 按擴充功能的「重新載入」，然後重新整理網頁 |
| 留言送出但截圖說 `not the visible tab` | 送出時那個分頁被切到背景了；回到那個分頁再送一次 |

更多細節在 `README.md`。
