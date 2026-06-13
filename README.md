# Rummikub Online 🟡🔵🔴⚫

Play a Rummikub-style tile game with someone in another city. One person starts a game and gets a room code; the other opens the shared link and joins. Turn-based, real-time over WebSockets, with each player's rack kept private. 2–4 players.

Same engine as a normal Rummikub: number **runs** (e.g. 4·5·6 one colour), **sets** (e.g. three 7s, different colours), a **30-point opening meld**, table rearranging after you've melded, **★ jokers**, and drawing when you can't play. First to empty their rack wins.

Built with Node + `ws`. One dependency, one port.

---

## The goal: send your sister a link

To play across states, the game has to live somewhere on the internet. You deploy this once (free), which gives you a public `https://…` address. That address **is** the link you send her. Steps below.

### Step 1 — put it online (one time, ~5 minutes)

The easy route is **Render**'s free tier:

1. Make a free account at [render.com](https://render.com) and a free [github.com](https://github.com) account if you don't have one.
2. Upload this `rummikub-online` folder to a new GitHub repository. (On GitHub: *New repository* → then *uploading an existing file* → drag the folder's contents in.)
3. In Render: **New → Web Service** → connect that repo.
4. Settings: Build command `npm install`, Start command `npm start`. Leave the rest default and **Create Web Service**.
5. After it builds you'll get a URL like `https://rummikub-online-xxxx.onrender.com`. That's your game.

Railway, Fly.io, and Glitch work the same way (import the repo, they run `npm start`). WebSockets work out of the box — the client auto-uses `wss://` on HTTPS.

> Heads-up on Render free: the service "sleeps" after ~15 min idle, so the very first visit after a quiet spell can take ~30 seconds to wake up. Fine for a casual game night.

### Step 2 — play

1. **You:** open your Render URL, type your name, tap **Start a new game**. You'll see a room code and a **"copy invite link for your sister"** button.
2. **Send her that link** (it already has the room code in it).
3. **She** opens it, types her name, taps **Join**.
4. When you both show up, you tap **Start game** and play. Your turn lights up; tap **End turn** when done, or **Draw & pass** if you can't play.

---

## Want to try it on your own laptop first?

```bash
cd rummikub-online
npm install
npm start
```

Open `http://localhost:3000`, start a game, then open a second browser window (or another device on the same Wi-Fi at `http://<your-ip>:3000`) and join with the code. Good for a dry run before deploying.

---

## How a turn works

- On your turn, drag tiles from your rack onto the table (or tap a tile, then tap where it goes). Sets glow gold when valid, red when not.
- Your **first** play must be your own tiles forming 30+ points. After that you can rearrange anything on the table as long as every group stays a valid run or set.
- **End turn** submits your play (the server checks it's legal). **Draw & pass** takes a tile and ends your turn. **Reset** undoes your current moves. **Sort** tidies your rack.
- First to empty their rack wins. If the pool runs out and nobody can play, fewest points left wins.

---

## Tweaks (top of `server.js`)

The game already allows **2–4 players** and starts at **2**. Other knobs: the deck and dealing live in `buildDeck`/`deal`. The look (felt, tiles, wood rack) is in the `<style>` block of `public/index.html`.

```
rummikub-online/
├── server.js            rules engine + turn validation + WebSocket sync
├── package.json
└── public/
    └── index.html       lobby + board + your private rack
```

No accounts, no database — games live in memory and clear out after everyone leaves.
