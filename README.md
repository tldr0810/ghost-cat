# 湊十幽靈貓 · Ghost Cat Tens

框住加起來剛好 10 的黑貓就會消掉。好友不在線上時，你挑戰的是他的「幽靈貓」：同一個盤面、同時開打，打完通知好友回來報仇。

- 介面：繁體中文、簡體中文、English（依瀏覽器語言自動選擇，開始畫面右上角可切換）
- 前端：`public/index.html` 單一檔案，手機優先，可以放進 Narra Messenger 的內嵌瀏覽器
- 後端：Cloudflare Worker，只負責 `/api/*`，幽靈貓的台詞由一個 Manyfold agent 透過 A2A 生成

## Agent 的角色

agent 只負責寫台詞，不碰遊戲本身：

| 誰決定 | 什麼 |
| --- | --- |
| 程式 | 盤面、幽靈的每一步、分數、勝負 |
| Manyfold agent | 幽靈貓說的話（開局、超車、大組合、最後十秒、輸贏…），用好友的語氣、玩家選的語言 |

- 開始畫面一打開就先幫每隻幽靈預抓台詞，按下去通常馬上開局。
- 一次 agent 對話就生成整局的台詞；同一隻幽靈、同一種語言在 `LINES_CACHE_SECONDS`（預設 600 秒）內重複使用，不會每局都計費。
- agent 沒設定、逾時、回覆格式不對，遊戲都會自動改用內建台詞，不會卡住。
- agent 回的每一句都會檢查長度和格式，畫面上只用純文字顯示。

## 部署

```bash
npm install
npx wrangler secret put MANYFOLD_AGENT_RPC_URL   # agent 的 A2A JSON-RPC 端點
npx wrangler secret put MANYFOLD_AGENT_TOKEN     # agent 的 A2A bearer token
npm run deploy
```

部署後打開 `/api/health`，看到 `{"ok":true,"agent":true}` 就代表 agent 已設定。

agent 的 RPC 端點和 token 從 Manyfold 拿：在該 agent 的設定裡開啟 A2A，並產生一組憑證。不要把它們寫進程式碼或 commit 進 repo。

## 本機開發

```bash
cp .dev.vars.example .dev.vars   # 填入 agent 的端點和 token
npm run dev
npm run check                    # 型別檢查 + 部署 dry run
```

## 還沒接的部分

`public/index.html` 裡的 `Platform` 物件是所有外部串接點：

- `getFriendGhosts`：目前是兩隻內建幽靈（阿凱、小芸），正式版應該來自 Narra 的好友名單和他們的對局紀錄
- `notifyFriend`：通知好友「你的幽靈貓被打爆了」，要接 Narra 的私訊或推播
- `shareResult`：目前用系統分享或複製文字，可以改成直接發到 Narra 聊天室

`src/a2a.ts` 取自 [manyfold-open/manyfold-fortune-stick](https://github.com/manyfold-open/manyfold-fortune-stick)（MIT License）。
