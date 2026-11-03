# Ghost Cat Tens · 湊十幽靈貓

A make-ten puzzle with black cats. Drag a box around cats whose numbers add up to exactly 10 and they hop away. When a friend is offline, you play their "ghost cat" instead: the same board, at the same time. When the round ends, your friend is told so they can come back for a rematch. You can also skip the ghost and play a round on your own.

- **Languages:** Traditional Chinese, Simplified Chinese and English. The game picks one from the browser language, and you can switch in the top right of the start screen.
- **Front end:** a single file, `public/index.html`. It is built for phones first and can run inside Narra Messenger's in-app browser.
- **Back end:** a Cloudflare Worker that only handles `/api/*`. A Manyfold agent writes the ghost cats' lines over A2A.
- **Rounds:** 1,000 fixed rounds, each a board seed plus a rule set (make 10 or 15; 90, 60 or 45 seconds; numbers 1–5 only; double points for big boxes; pairs only). Share a round with `#v<n>`.

## What the agent does

The agent only writes the lines. It never touches the game itself.

| Who decides | What |
| --- | --- |
| The code | The board, every ghost move, the score, who wins |
| The Manyfold agent | What the ghost cat says (round start, overtaking, big combos, last ten seconds, win or lose), in the friend's voice and the player's language |

- The start screen prefetches lines for every ghost as soon as it opens, so a round usually starts at once.
- One agent conversation writes the lines for a whole round. The same ghost in the same language reuses them for `LINES_CACHE_SECONDS` (600 seconds by default), so not every round is billed.
- If the agent is not configured, times out or returns a bad format, the game falls back to built-in lines and keeps going.
- Every line from the agent is checked for length and format, and is shown as plain text only.

## Deploy

`main` is connected to Cloudflare Workers Builds. When a PR is merged into `main`, Cloudflare runs `npx wrangler deploy` on its own, so there is no manual deploy. The steps below are for the first setup or a manual deploy.

```bash
npm install
npx wrangler secret put MANYFOLD_AGENT_RPC_URL   # the agent's A2A JSON-RPC endpoint
npx wrangler secret put MANYFOLD_AGENT_TOKEN     # the agent's A2A bearer token
npm run deploy
```

After deploying, open `/api/health`. If it shows `{"ok":true,"agent":true}`, the agent is configured.

Get the agent's RPC endpoint and token from Manyfold: turn on A2A in the agent's settings and create a credential. Never put them in the code or commit them to the repo.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the agent's endpoint and token
npm run dev
npm run check                    # type check + deploy dry run
```

## Not connected yet

The `Platform` object in `public/index.html` holds every connection to the outside world:

- `getFriendGhosts`: two built-in ghosts for now (Kai and Yun). The real version should come from the player's Narra friends and their past games.
- `notifyFriend`: tells a friend "your ghost cat just lost". It needs Narra direct messages or push notifications.
- `shareResult`: uses the system share sheet or copies text for now. It could post straight into a Narra chat instead.

`src/a2a.ts` comes from [manyfold-open/manyfold-fortune-stick](https://github.com/manyfold-open/manyfold-fortune-stick) (MIT License).
