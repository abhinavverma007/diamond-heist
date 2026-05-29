# 💎 Diamond Heist: Underground Heist

> *You're deep inside Earth's mantle. Diamonds glow in the dark. Ten miners. One diamond. First to land on it claims it — but the mine has surprises buried in every corner.*

Mobile-first, real-time multiplayer board game for 2–10 players. Built for chaos, designed for one-more-round addiction.

---

## Stack

| Layer | Tech |
|---|---|
| Client | Angular 16, Tailwind CSS, socket.io-client 4 |
| Server | Node.js, Express, socket.io 4, TypeScript |
| Deploy | Vercel (client) + Render (server) |

---

## How to Play

1. **Enter the mine** — Create a room (you become Host) or join with a 4-letter code.
2. **Gear up** — Pick your miner emoji and tagline. Tap **I am Ready**.
3. **Host starts the dig** — once all miners are ready, host chooses diamond count and taps **Start Game**.
4. **Your turn** — tap **🎲 Roll Dice**, then pick a direction on the D-pad to move that many tiles.
5. **Claim the diamond** — land exactly on 💎 to claim it. Most diamonds claimed wins the session.
6. **Watch the clock** — each turn has a **45-second timer**. Run out and your turn is auto-skipped.
7. **Mystery boxes** — land on 🎁 to trigger a random outcome. Could be your best move or your worst.
8. **Play Again** — scores carry over across rounds until the room is closed.

---

## Mystery Box Outcomes

| Outcome | Emoji | Points | Probability | Effect |
|---|---|---|---|---|
| Points Jackpot | 💸 | **+50 pts** | 20% | Pure gain |
| Steal Points | 💰 | **+10 × N pts** | 1 per game | Takes 10 pts from every other active player |
| Dud | 💨 | **0 pts** | 30% | Nothing happens |
| Warp Back | ↩️ | **−15 pts** | 30% | Teleported back to your starting position |
| Bomb | 💣 | **−20 pts** | 20% | Direct point deduction |

> Exactly **one** Steal Points box is guaranteed per game. Scores can go negative.

---

## Session Points Economy

| Action | Points |
|---|---|
| Claim 1st diamond | +100 |
| Claim 2nd diamond | +70 |
| Claim 3rd+ diamond | +50 |
| Complete a game (everyone) | +10 |
| Open 💸 Jackpot box | +50 |
| Open 💰 Steal box | +10 × other players |
| Open 💣 Bomb box | −20 |
| Open ↩️ Warp Back box | −15 |
| Open 💨 Dud box | 0 |

Session leaderboard persists across **Play Again** cycles and resets only when the room is destroyed.

---

## Project Structure

```
diamondheist/
├── client/                         # Angular app → Vercel
│   ├── src/
│   │   ├── app/
│   │   │   ├── services/
│   │   │   │   ├── socket.service.ts
│   │   │   │   └── sound.service.ts
│   │   │   ├── game/
│   │   │   │   ├── game.component.ts
│   │   │   │   ├── game.component.html
│   │   │   │   └── game.component.css
│   │   │   ├── app.component.ts|html
│   │   │   └── app.module.ts
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── styles.css              # Global theme + animations
│   ├── angular.json
│   ├── tailwind.config.js
│   ├── vercel.json
│   └── package.json
├── server/
│   ├── src/server.ts               # All game logic lives here
│   ├── tsconfig.json
│   └── package.json
└── README.md
```

---

## Local Development

### 1 — Start the server

```bash
cd diamondheist/server
npm install
npm run dev          # ts-node hot-reload on :3001
```

### 2 — Start the client

```bash
cd diamondheist/client
npm install
npm start            # ng serve → http://localhost:4200
```

Open **two browser tabs** at `localhost:4200`, create a room in one and join with the code in the other.

---

## Production Deployment

### Server → Render

1. New **Web Service**, root directory `diamondheist/server`.
2. Build: `npm install && npm run build`
3. Start: `npm start`
4. Render sets `PORT` automatically.

### Client → Vercel

1. Update the server URL in [client/src/app/services/socket.service.ts](client/src/app/services/socket.service.ts):
   ```ts
   return 'https://YOUR-SERVICE.onrender.com';
   ```
2. Import the repo into Vercel, set **Root Directory** → `diamondheist/client`.
3. `vercel.json` handles SPA rewrites and build config automatically.

---

## Architecture

| Concern | Approach |
|---|---|
| Room isolation | Server-side `rooms` map; each socket joins a Socket.io room keyed by the 4-char code |
| Turn enforcement | Server validates `socket.id === playerOrder[turnIndex]` before every move/roll |
| Turn timer | Server-side 45 s `setTimeout` per turn; fires `turn_skipped` on expiry and restarts for next player |
| Mystery boxes | Zone-spread spawn (4-col × 3-row = 12 zones, 10 boxes placed); one guaranteed Steal box pre-assigned at spawn; all others randomised at open-time |
| Session scores | Keyed by `sessionId` (survives reconnect); survives `play_again`; can go negative |
| Reconnect | 60 s grace window; player slot held by `sessionId`; full board + score state restored on rejoin |
| Diamond spawn | Random in inner quarter of the 21×21 grid; never on a player starting cell |
| Board rendering | Flat 441-cell array rebuilt on each state event; zero per-frame function calls in template |
| Player removal | `removePlayerFromRoom` clamps `turnIndex`, restarts turn timer, broadcasts updated leaderboard |
| Mobile UX | `touch-action: manipulation` on all interactive elements (no 300 ms tap delay); haptic via `navigator.vibrate` |
| Sound | Web Audio API oscillators only — no external audio files, no network requests |

---

## Feature Highlights

- ⛏ **Underground mine theme** — volcanic background, rock-frame board, amber ore-vein grid lines, diamond glints embedded in cave walls
- 🎁 **Mystery boxes** — 10 per game, zone-spread so no corner of the board is unfair
- 📊 **Session leaderboard** — real-time, persists across rounds, visible in lobby and game
- ⏱ **45 s turn timer** — circular conic-gradient countdown visible to all players; auto-skip on expiry
- 😄 **Floating reactions** — Google Meet-style emoji and Hinglish text balloons visible to all
- 🎨 **Miner customiser** — 48 emoji avatars (6 rows) + 10 Hinglish taglines
- 🔊 **Sound + haptics** — synthesised Web Audio effects; toggleable mid-game
- 📱 **Mobile-first** — designed and tested for phone screen sizes
- 🔌 **Reconnect** — 60 s grace window; rejoin mid-game with full state restored
- 👥 **Up to 10 players** — adaptive footer (name list ≤ 4 players; emoji grid 5+)

---

## Backlog

- [ ] Shareable invite link (one-tap share to WhatsApp / Discord)
- [ ] End-of-game scorecard image (shareable PNG)
- [ ] Spectator mode (join after game started, read-only)
- [ ] Rematch vote (democratic instead of host-only)
- [ ] Obstacle / wall tiles for strategic pathing
- [ ] Seasonal board themes (Halloween, Diwali, Christmas)
