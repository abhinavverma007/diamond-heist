# 💎 Diamond Heist: Mini Arenas

Mobile-first, turn-based multiplayer board game. Race to land on the diamond before your opponents!

## Stack

| Layer | Tech |
|---|---|
| Client | Angular 16, Tailwind CSS, socket.io-client 4 |
| Server | Node.js, Express, socket.io 4, TypeScript |
| Deploy | Vercel (client) + Render (server) |

## Game Rules

1. **Create** a room (you become Host) or **Join** one with a 4-letter code.
2. Host taps **Start Game** once ≥ 2 players are in the lobby.
3. On your turn tap **🎲 Roll Dice** to get 1–6 steps.
4. Tap the D-pad **exactly** that many times (1 tile per tap).
5. The first player to **land on 💎** wins instantly.
6. A winner modal pops for **all players simultaneously**.
7. Tap **Play Again** to reset back into the same lobby.

## Project Structure

```
diamondheist/
├── client/                        # Angular app → Vercel
│   ├── src/
│   │   ├── app/
│   │   │   ├── services/socket.service.ts
│   │   │   ├── game/game.component.ts|html|css
│   │   │   ├── app.component.ts|html
│   │   │   └── app.module.ts
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── styles.css
│   ├── angular.json
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── vercel.json
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   └── package.json
├── server/                        # Node.js TS server → Render
│   ├── src/server.ts
│   ├── tsconfig.json
│   └── package.json
└── README.md
```

## Local Development

### 1 – Start the server

```bash
cd diamondheist/server
npm install
npm run dev          # ts-node hot-reload on :3001
```

### 2 – Start the client

```bash
cd diamondheist/client
npm install
npm start            # ng serve → http://localhost:4200
```

Open **two browser tabs** at `localhost:4200`, create/join the same room code.

## Production Deployment

### Server → Render

1. New **Web Service**, root directory `diamondheist/server`.
2. Build: `npm install && npm run build`
3. Start: `npm start`
4. Render sets `PORT` automatically.

### Client → Vercel

1. Update the Render URL in [client/src/app/services/socket.service.ts](client/src/app/services/socket.service.ts):
   ```ts
   return 'https://YOUR-SERVICE.onrender.com';
   ```
2. Import the repo into Vercel, set **Root Directory** → `diamondheist/client`.
3. `vercel.json` handles SPA rewrites and build config automatically.

## Architecture Highlights

| Concern | Approach |
|---|---|
| Room isolation | Server-side `rooms` map; each socket joins a Socket.io room keyed by the 4-char code |
| Turn enforcement | Server validates `socket.id === playerOrder[turnIndex]` before processing every move/roll |
| Bounds checking | Server clamps to 0–14; off-grid moves are rejected **without consuming a step** |
| Diamond spawn | Random position in the 6–9 hot zone — never exact centre, never on a starting corner |
| Play Again | Any player triggers reset; server is idempotent (ignores mid-game requests) |
| Mobile anti-zoom | `touch-action: manipulation` on every interactive element — no 300 ms delay |
| Text selection | `user-select: none` globally; re-enabled only on `<input>` elements |
| Grid rendering | Flat 225-cell array rebuilt on each state event — zero per-frame template function calls |

## TODO Backlog

- [ ] WebSocket reconnect banner with progress indicator
- [ ] Local-storage persistence for player name
- [ ] Room code regex validation before emit
- [ ] Spectator mode (join after game started, read-only view)
- [ ] Obstacle/wall tiles for strategic pathing
- [ ] Sound effects via Web Audio API
- [ ] Countdown timer per turn
