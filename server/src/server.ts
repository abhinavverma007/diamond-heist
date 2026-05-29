import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';

// TODO: Implement WebSocket Connection Error Handling (reconnect backoff, heartbeat monitoring)
// TODO: Add per-socket rate limiting to prevent dice-roll spam

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3001;
const GRID_SIZE = 21;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  startX: number; // perimeter start position for warp_back box outcome
  startY: number;
  isHost: boolean;
  color: string;
  emoji: string;
  tagline: string;
  ready: boolean;
  sessionId: string;
  disconnected: boolean;
  won: boolean;
  reactionAt: number; // unix ms – for rate limiting reactions
}

type BoxOutcome = 'warp_back' | 'points_jackpot' | 'dud' | 'bomb' | 'steal_points';

interface Box {
  id: number;
  pos: Point;
  // outcome is only pre-set for the guaranteed steal_points box;
  // all other boxes randomize from BOX_OUTCOME_POOL at open-time
  outcome?: BoxOutcome;
}

interface SessionEntry {
  playerId: string;
  name: string;
  emoji: string;
  score: number;
}

interface Point {
  x: number;
  y: number;
}

interface Winner {
  id: string;
  name: string;
  place: number;
  emoji: string;
}

interface RoomState {
  players: Record<string, Player>;
  playerOrder: string[];
  turnIndex: number;
  diamond: Point | null;
  diamondsRemaining: number;
  currentRoll: number;
  stepsRemaining: number;
  gameStarted: boolean;
  winners: Winner[];
  boxes: Box[];
  sessionScores: Record<string, number>; // keyed by sessionId
  gamesPlayed: number;
  turnDuration: number;                  // seconds per turn; 0 = disabled
  turnTimerHandle: ReturnType<typeof setTimeout> | null;
  lastActivityAt: number;                // unix ms – for TTL eviction
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_EMOJIS = new Set([
  // Animals
  '🦁','🐯','🦊','🐼','🦝','🐺','🦄','🦈',
  // Haha / fun faces
  '😂','🤣','😆','😄','😁','🤪','😜','🥳',
  // Characters
  '👻','💀','🤖','👽','🎃','🥷','🦸','🤡',
  // Games & misc
  '🎮','🚀','🏆','🎯','⚡','🃏','🎪','🎠',
  // Dice faces 1–6
  '⚀','⚁','⚂','⚃','⚄','⚅','🎲','🎰',
  // Food
  '🍕','🌮','🍜','🍩','🧁','🍦','🍎','🍓',
]);

const ALLOWED_TAGLINES = new Set([
  'tumse na ho payega',
  'mai jitne wala hoon',
  'diamond mera hi hai',
  'bhai, try mat karo',
  'baap aa gaya',
  'lucky shot incoming 🔥',
  'seedha home jaoge',
  'ek number legend',
  'hum nahi jeete toh kaun?',
  'khelna hai toh jhel na',
]);

const PLAYER_COLORS = [
  '#ef4444', // red
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
];
const PLAYER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ─── In-memory stores ────────────────────────────────────────────────────────

const rooms: Record<string, RoomState> = {};

// Keyed by sessionId – cleared when player reconnects or timer fires
const disconnectTimers: Record<string, ReturnType<typeof setTimeout>> = {};

// ─── Room TTL eviction ────────────────────────────────────────────────────────
// Runs every 10 min; deletes any room with no activity for 2 hours.
// Prevents heap accumulation from abandoned rooms where all players dropped
// without triggering the normal disconnect → grace-timer → removal flow.
const ROOM_TTL_MS       = 2 * 60 * 60 * 1000; // 2 hours
const ROOM_TTL_CHECK_MS =     10 * 60 * 1000;  // check every 10 min

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of Object.entries(rooms)) {
    if (now - room.lastActivityAt > ROOM_TTL_MS) {
      clearTurnTimer(room);
      io.to(code).emit('room_expired', { message: 'Room closed after 2 hours of inactivity.' });
      io.in(code).disconnectSockets(true);
      delete rooms[code];
      console.log(`[Room ${code}] TTL evicted – inactive for 2 h`);
    }
  }
}, ROOM_TTL_CHECK_MS).unref(); // .unref() so this timer doesn't keep the process alive alone

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function generateRoomCode(): string {
  // TODO: Validate Room Code formatting before emitting (exclude ambiguous chars O/0, I/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function uniqueRoomCode(): string {
  let code = generateRoomCode();
  while (rooms[code]) code = generateRoomCode();
  return code;
}

function getPerimeter(): Point[] {
  const max = GRID_SIZE - 1;
  const pts: Point[] = [];
  for (let x = 0; x <= max; x++) pts.push({ x, y: 0 });
  for (let y = 1; y <= max; y++) pts.push({ x: max, y });
  for (let x = max - 1; x >= 0; x--) pts.push({ x, y: max });
  for (let y = max - 1; y >= 1; y--) pts.push({ x: 0, y });
  return pts;
}

function assignStartPositions(room: RoomState): void {
  const perimeter = getPerimeter();
  const total = room.playerOrder.length;
  room.playerOrder.forEach((id, idx) => {
    const p = room.players[id];
    if (!p) return;
    const periIdx = Math.floor((idx * perimeter.length) / total);
    p.x = perimeter[periIdx].x;
    p.y = perimeter[periIdx].y;
    p.startX = p.x;
    p.startY = p.y;
  });
}

// ── Box zone-spread spawning ──────────────────────────────────────────────────
// Divides the 21×21 grid into a 4-col × 3-row grid of 12 zones.
// Picks 10 random zones and places one box per zone, avoiding the diamond
// and all player starting positions. Outcomes are weighted.
const BOX_OUTCOME_POOL: BoxOutcome[] = [
  'warp_back',   'warp_back',   'warp_back',
  'points_jackpot', 'points_jackpot',
  'dud',         'dud',         'dud',
  'bomb',        'bomb',
];

let boxIdCounter = 0;

function spawnBoxes(room: RoomState): void {
  const ZONE_COLS = 4;
  const ZONE_ROWS = 3;
  const zoneW = Math.floor(GRID_SIZE / ZONE_COLS); // ~5
  const zoneH = Math.floor(GRID_SIZE / ZONE_ROWS); // ~7

  // Forbidden cells: diamond + all player starting positions
  const forbidden = new Set<string>();
  if (room.diamond) forbidden.add(`${room.diamond.x},${room.diamond.y}`);
  room.playerOrder.forEach(id => {
    const p = room.players[id];
    if (p) forbidden.add(`${p.x},${p.y}`);
  });

  // Shuffle zone indices [0..11], pick first 10
  const zones = Array.from({ length: ZONE_COLS * ZONE_ROWS }, (_, i) => i);
  for (let i = zones.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [zones[i], zones[j]] = [zones[j], zones[i]];
  }

  const boxes: Box[] = [];
  for (const zoneIdx of zones.slice(0, 10)) {
    const col = zoneIdx % ZONE_COLS;
    const row = Math.floor(zoneIdx / ZONE_COLS);
    const x0 = col * zoneW;
    const y0 = row * zoneH;

    for (let attempt = 0; attempt < 30; attempt++) {
      const x = x0 + Math.floor(Math.random() * zoneW);
      const y = y0 + Math.floor(Math.random() * zoneH);
      const key = `${x},${y}`;
      if (!forbidden.has(key)) {
        forbidden.add(key);
        boxes.push({ id: boxIdCounter++, pos: { x, y } });
        break;
      }
    }
  }

  // Guarantee exactly one steal_points box per game – pre-assign to a random box
  if (boxes.length > 0) {
    const idx = Math.floor(Math.random() * boxes.length);
    boxes[idx].outcome = 'steal_points';
  }

  room.boxes = boxes;
}

// ── Open a box and apply its effect ──────────────────────────────────────────
function openBox(
  room: RoomState,
  playerId: string,
  box: Box,
): { outcome: BoxOutcome; label: string; emoji: string; pointsDelta: number } {
  const player = room.players[playerId];
  if (!player) return { outcome: 'dud', label: 'Nothing!', emoji: '💨', pointsDelta: 0 };

  // Remove from board immediately
  room.boxes = room.boxes.filter(b => b.id !== box.id);

  // Use the pre-assigned outcome (steal_points) if present; otherwise fresh random roll
  const outcome: BoxOutcome = box.outcome ?? BOX_OUTCOME_POOL[Math.floor(Math.random() * BOX_OUTCOME_POOL.length)];

  const sid = player.sessionId;
  const current = room.sessionScores[sid] ?? 0;
  let pointsDelta = 0;
  let label = '';
  let emoji = '';

  switch (outcome) {
    case 'steal_points': {
      const others = room.playerOrder.filter(
        id => id !== playerId && !room.players[id]?.disconnected,
      );
      const gain = others.length * 10;
      others.forEach(id => {
        const p = room.players[id];
        if (p) room.sessionScores[p.sessionId] = (room.sessionScores[p.sessionId] ?? 0) - 10;
      });
      room.sessionScores[sid] = current + gain;
      pointsDelta = gain;
      label = `Stole 10 pts from ${others.length} player${others.length !== 1 ? 's' : ''}!`;
      emoji = '💰';
      break;
    }
    case 'warp_back':
      player.x = player.startX;
      player.y = player.startY;
      pointsDelta = -15;
      room.sessionScores[sid] = current - 15;
      label = 'Warped back! -15 pts';
      emoji = '↩️';
      break;
    case 'points_jackpot':
      pointsDelta = 50;
      room.sessionScores[sid] = current + 50;
      label = '+50 Points Jackpot!';
      emoji = '💸';
      break;
    case 'bomb':
      pointsDelta = -20;
      room.sessionScores[sid] = current - 20;
      label = 'Bomb! -20 pts 💥';
      emoji = '💣';
      break;
    case 'dud':
    default:
      pointsDelta = 0;
      label = 'Nothing… 😅';
      emoji = '💨';
      break;
  }
  return { outcome, label, emoji, pointsDelta };
}

// ── Build sorted session leaderboard for client payloads ─────────────────────
function getSessionLeaderboard(room: RoomState): SessionEntry[] {
  return room.playerOrder
    .map(id => {
      const p = room.players[id];
      if (!p) return null;
      return { playerId: id, name: p.name, emoji: p.emoji, score: room.sessionScores[p.sessionId] ?? 0 };
    })
    .filter((e): e is SessionEntry => !!e)
    .sort((a, b) => b.score - a.score);
}

function spawnDiamond(players: Record<string, Player>): Point {
  const MAX_ATTEMPTS = 100;
  const center = Math.floor(GRID_SIZE / 2);
  const zone = Math.floor(GRID_SIZE / 4);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = center - zone + Math.floor(Math.random() * (zone * 2 + 1));
    const y = center - zone + Math.floor(Math.random() * (zone * 2 + 1));
    if (!Object.values(players).some(p => p.x === x && p.y === y)) return { x, y };
  }
  return { x: center, y: center };
}

function removePlayerFromRoom(roomCode: string, playerId: string): void {
  const room = rooms[roomCode];
  if (!room || !room.players[playerId]) return;

  const wasHost     = room.players[playerId].isHost;
  const leavingIdx  = room.playerOrder.indexOf(playerId);
  const sessionId   = room.players[playerId].sessionId;

  // Remove orphaned score entry so sessionScores doesn't grow unboundedly
  delete room.sessionScores[sessionId];

  delete room.players[playerId];
  room.playerOrder = room.playerOrder.filter(id => id !== playerId);

  if (room.playerOrder.length === 0) {
    clearTurnTimer(room); // prevent dangling closure after room is gone
    delete rooms[roomCode];
    console.log(`[Room ${roomCode}] Empty – deleted`);
    return;
  }

  if (wasHost) room.players[room.playerOrder[0]].isHost = true;

  room.playerOrder.forEach((id, idx) => {
    room.players[id].color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
  });

  // Clamp turnIndex so it never goes out of bounds after the player list shrinks.
  // If the leaving player held the turn, the index now points to the next player
  // naturally (same index, shorter array). If it was the last slot, wrap to 0.
  if (room.gameStarted) {
    clearTurnTimer(room);
    if (room.turnIndex >= room.playerOrder.length) {
      room.turnIndex = 0;
    } else if (leavingIdx < room.turnIndex) {
      // A player before the current turn was removed – shift index back by 1
      room.turnIndex = Math.max(0, room.turnIndex - 1);
    }
    startTurnTimer(roomCode, room);
  }

  io.to(roomCode).emit('player_left', {
    players: room.players,
    playerOrder: room.playerOrder,
    turnIndex: room.turnIndex,
    currentPlayerId: room.playerOrder[room.turnIndex] ?? '',
    sessionLeaderboard: getSessionLeaderboard(room),
  });
}

function advanceTurn(room: RoomState): void {
  const total = room.playerOrder.length;
  let next = (room.turnIndex + 1) % total;
  let skipped = 0;
  while (skipped < total && room.players[room.playerOrder[next]]?.won) {
    next = (next + 1) % total;
    skipped++;
  }
  room.turnIndex = next;
  room.currentRoll = 0;
  room.stepsRemaining = 0;
}

function clearTurnTimer(room: RoomState): void {
  if (room.turnTimerHandle) {
    clearTimeout(room.turnTimerHandle);
    room.turnTimerHandle = null;
  }
}

function startTurnTimer(roomCode: string, room: RoomState): void {
  clearTurnTimer(room);
  if (!room.gameStarted || room.playerOrder.length === 0) return;
  if (room.turnDuration === 0) return; // timer disabled by host

  room.turnTimerHandle = setTimeout(() => {
    room.turnTimerHandle = null;
    if (!room.gameStarted) return;

    const skippedId  = room.playerOrder[room.turnIndex];
    const skippedName = room.players[skippedId]?.name ?? '';
    room.currentRoll   = 0;
    room.stepsRemaining = 0;
    advanceTurn(room);
    const nextId = room.playerOrder[room.turnIndex];

    io.to(roomCode).emit('turn_skipped', {
      skippedPlayerId:   skippedId,
      skippedPlayerName: skippedName,
      players:           room.players,
      stepsRemaining:    0,
      turnIndex:         room.turnIndex,
      currentPlayerId:   nextId,
      currentPlayerName: room.players[nextId]?.name ?? '',
    });

    // Restart timer for the next player
    startTurnTimer(roomCode, room);
  }, room.turnDuration * 1000);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ───────────────────────────────────────────────────────────

  socket.on('create_room', ({ playerName }: { playerName: string }) => {
    const name = (playerName || '').trim().slice(0, 16) || 'Player 1';
    const roomCode = uniqueRoomCode();

    const player: Player = {
      id: socket.id,
      name,
      x: 0, y: 0, startX: 0, startY: 0,
      isHost: true,
      color: PLAYER_COLORS[0],
      emoji: PLAYER_EMOJIS[0],
      tagline: '',
      ready: false,
      sessionId: generateSessionId(),
      disconnected: false,
      won: false,
      reactionAt: 0,
    };

    rooms[roomCode] = {
      players: { [socket.id]: player },
      playerOrder: [socket.id],
      turnIndex: 0,
      diamond: null,
      diamondsRemaining: 0,
      currentRoll: 0,
      stepsRemaining: 0,
      gameStarted: false,
      winners: [],
      boxes: [],
      turnDuration: 60,
      turnTimerHandle: null,
      lastActivityAt: Date.now(),
      sessionScores: {},
      gamesPlayed: 0,
    };

    socket.join(roomCode);
    socket.emit('room_created', {
      roomCode,
      playerId: socket.id,
      sessionId: player.sessionId,
      player,
      players: rooms[roomCode].players,
      playerOrder: rooms[roomCode].playerOrder,
    });

    console.log(`[Room ${roomCode}] Created by "${name}"`);
  });

  // ── Join Room ─────────────────────────────────────────────────────────────

  socket.on('join_room', ({ roomCode, playerName }: { roomCode: string; playerName: string }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const name = (playerName || '').trim().slice(0, 16);
    const room = rooms[code];

    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.gameStarted) {
      socket.emit('join_error', { message: 'Game already in progress. Please wait.' });
      return;
    }

    const idx = room.playerOrder.length;
    const player: Player = {
      id: socket.id,
      name: name || `Player ${idx + 1}`,
      x: 0, y: 0, startX: 0, startY: 0,
      isHost: false,
      color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
      emoji: PLAYER_EMOJIS[idx % PLAYER_EMOJIS.length],
      tagline: '',
      ready: false,
      sessionId: generateSessionId(),
      disconnected: false,
      won: false,
      reactionAt: 0,
    };

    room.players[socket.id] = player;
    room.playerOrder.push(socket.id);
    room.lastActivityAt = Date.now();

    socket.join(code);

    socket.emit('room_joined', {
      roomCode: code,
      playerId: socket.id,
      sessionId: player.sessionId,
      player,
      players: room.players,
      playerOrder: room.playerOrder,
    });

    socket.to(code).emit('player_joined', {
      players: room.players,
      playerOrder: room.playerOrder,
    });

    console.log(`[Room ${code}] "${name}" joined`);
  });

  // ── Start Game ────────────────────────────────────────────────────────────

  socket.on('start_game', ({ roomCode, diamondCount, turnDuration }: { roomCode: string; diamondCount?: number; turnDuration?: number }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player?.isHost) {
      socket.emit('game_error', { message: 'Only the host can start the game.' });
      return;
    }
    if (room.playerOrder.length < 2) {
      socket.emit('game_error', { message: 'Need at least 2 players to start.' });
      return;
    }
    if (room.gameStarted) return;

    // All players must have clicked "I am Ready" before host can start
    const notReady = room.playerOrder.filter(id => !room.players[id]?.ready);
    if (notReady.length > 0) {
      socket.emit('game_error', { message: 'Waiting for all players to click Ready!' });
      return;
    }

    const count = Math.min(Math.max(1, diamondCount ?? 1), 6);
    // 0 = disabled; clamp valid values to 15–180 s
    room.turnDuration = turnDuration === 0 ? 0 : Math.min(180, Math.max(15, turnDuration ?? 60));
    room.gameStarted = true;
    room.winners = [];
    room.turnIndex = 0;
    room.currentRoll = 0;
    room.stepsRemaining = 0;
    assignStartPositions(room);
    room.playerOrder.forEach(id => { if (room.players[id]) room.players[id].won = false; });
    room.diamond = spawnDiamond(room.players);
    room.diamondsRemaining = count;
    spawnBoxes(room);

    const firstId = room.playerOrder[0];

    io.to(roomCode).emit('game_started', {
      players: room.players,
      playerOrder: room.playerOrder,
      diamond: room.diamond,
      diamondsRemaining: room.diamondsRemaining,
      turnIndex: room.turnIndex,
      currentPlayerId: firstId,
      currentPlayerName: room.players[firstId].name,
      boxes: room.boxes.map(b => ({ id: b.id, pos: b.pos })),
      sessionLeaderboard: getSessionLeaderboard(room),
      gamesPlayed: room.gamesPlayed,
      turnDuration: room.turnDuration,
    });

    startTurnTimer(roomCode, room);
    console.log(`[Room ${roomCode}] Game started – ${count} diamond(s) stacked at (${room.diamond.x},${room.diamond.y})`);
  });

  // ── Ready Up ─────────────────────────────────────────────────────────────
  // TODO: Add unready_up event so players can toggle back before game starts

  socket.on('ready_up', ({ roomCode }: { roomCode: string }) => {
    const room = rooms[roomCode];
    if (!room || room.gameStarted) return;

    const player = room.players[socket.id];
    if (!player || player.ready) return; // idempotent – ignore if already ready

    player.ready = true;
    console.log(`[Room ${roomCode}] "${player.name}" is ready`);

    io.to(roomCode).emit('player_ready_update', {
      players: room.players,
      playerOrder: room.playerOrder,
    });
  });

  // ── Roll Dice ─────────────────────────────────────────────────────────────

  socket.on('roll_dice', ({ roomCode }: { roomCode: string }) => {
    const room = rooms[roomCode];
    if (!room?.gameStarted) return;

    const currentId = room.playerOrder[room.turnIndex];
    if (socket.id !== currentId) {
      socket.emit('game_error', { message: "It's not your turn." });
      return;
    }
    if (room.stepsRemaining > 0) {
      socket.emit('game_error', { message: 'You already rolled. Use your moves first.' });
      return;
    }

    room.lastActivityAt = Date.now();
    const roll = Math.floor(Math.random() * 6) + 1;
    room.currentRoll = roll;
    room.stepsRemaining = roll;

    io.to(roomCode).emit('dice_rolled', {
      roll,
      stepsRemaining: roll,
      currentPlayerId: currentId,
      currentPlayerName: room.players[currentId].name,
    });
  });

  // ── Move Player ───────────────────────────────────────────────────────────

  socket.on('move_player', ({
    roomCode,
    direction,
  }: {
    roomCode: string;
    direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  }) => {
    const room = rooms[roomCode];
    if (!room?.gameStarted) return;

    const currentId = room.playerOrder[room.turnIndex];
    if (socket.id !== currentId) {
      socket.emit('game_error', { message: "It's not your turn." });
      return;
    }
    if (room.stepsRemaining <= 0) {
      socket.emit('game_error', { message: 'Roll the dice first.' });
      return;
    }

    const player = room.players[socket.id];
    const steps = room.stepsRemaining;
    let nx = player.x;
    let ny = player.y;

    // Move ALL rolled steps in the chosen direction at once.
    // TODO: Add obstacle/wall tiles that also cause early stop
    for (let i = 0; i < steps; i++) {
      let tx = nx;
      let ty = ny;

      switch (direction) {
        case 'UP':    ty--; break;
        case 'DOWN':  ty++; break;
        case 'LEFT':  tx--; break;
        case 'RIGHT': tx++; break;
      }

      // Stop at board edge – player keeps whatever distance they covered
      if (tx < 0 || tx >= GRID_SIZE || ty < 0 || ty >= GRID_SIZE) break;

      nx = tx;
      ny = ty;
    }

    player.x = nx;
    player.y = ny;
    room.stepsRemaining = 0;
    room.lastActivityAt = Date.now();

    // Player moved – cancel the running turn timer immediately
    clearTurnTimer(room);

    // Win only when the player lands exactly on the diamond cell – passing through doesn't count
    const hitDiamond = room.diamond && nx === room.diamond.x && ny === room.diamond.y;

    if (hitDiamond) {
      room.diamondsRemaining--;

      const place = room.winners.length + 1;
      const winner: Winner = { id: socket.id, name: player.name, place, emoji: player.emoji };
      room.winners.push(winner);
      player.won = true;

      // Award place-based session points
      const sid = player.sessionId;
      const pts = place === 1 ? 100 : place === 2 ? 70 : 50;
      room.sessionScores[sid] = (room.sessionScores[sid] ?? 0) + pts;

      const gameOver = room.diamondsRemaining === 0;
      if (gameOver) { room.diamond = null; room.gameStarted = false; }

      advanceTurn(room);
      const nextId = room.playerOrder[room.turnIndex];

      io.to(roomCode).emit('diamond_claimed', {
        winner,
        diamond: room.diamond,
        remainingCount: room.diamondsRemaining,
        players: room.players,
        stepsRemaining: 0,
        turnIndex: room.turnIndex,
        currentPlayerId: nextId,
        turnChanged: true,
        gameOver,
        sessionLeaderboard: getSessionLeaderboard(room),
      });

      if (gameOver) {
        // Award participation points to all connected players
        room.playerOrder.forEach(id => {
          const p = room.players[id];
          if (p && !p.disconnected) {
            room.sessionScores[p.sessionId] = (room.sessionScores[p.sessionId] ?? 0) + 10;
          }
        });
        room.gamesPlayed++;
        io.to(roomCode).emit('game_won', {
          winners: room.winners,
          players: room.players,
          sessionLeaderboard: getSessionLeaderboard(room),
          gamesPlayed: room.gamesPlayed,
        });
        console.log(`[Room ${roomCode}] All diamonds claimed. Winners: ${room.winners.map(w => w.name).join(', ')}`);
      } else {
        startTurnTimer(roomCode, room);
        console.log(`[Room ${roomCode}] "${player.name}" claimed diamond #${place} – ${room.diamondsRemaining} left on cell`);
      }
      return;
    }

    // ── Check if player landed on a mystery box ──────────────────────────────
    const hitBox = room.boxes.find(b => b.pos.x === nx && b.pos.y === ny);
    if (hitBox) {
      const result = openBox(room, socket.id, hitBox);
      advanceTurn(room);
      const nextId = room.playerOrder[room.turnIndex];
      io.to(roomCode).emit('box_opened', {
        boxId: hitBox.id,
        outcome: result.outcome,
        label: result.label,
        emoji: result.emoji,
        pointsDelta: result.pointsDelta,
        openerName: player.name,
        openerEmoji: player.emoji,
        players: room.players,
        stepsRemaining: 0,
        turnIndex: room.turnIndex,
        currentPlayerId: nextId,
        currentPlayerName: room.players[nextId]?.name ?? '',
        turnChanged: true,
        sessionLeaderboard: getSessionLeaderboard(room),
      });
      startTurnTimer(roomCode, room);
      console.log(`[Room ${roomCode}] "${player.name}" opened box → ${result.outcome} (${result.label})`);
      return;
    }

    // ── Turn always advances after a direction is chosen ────────────────────
    advanceTurn(room);
    const nextId = room.playerOrder[room.turnIndex];
    io.to(roomCode).emit('player_moved', {
      players: room.players,
      stepsRemaining: 0,
      turnIndex: room.turnIndex,
      currentPlayerId: nextId,
      currentPlayerName: room.players[nextId].name,
      turnChanged: true,
    });
    startTurnTimer(roomCode, room);
  });

  // ── Play Again ────────────────────────────────────────────────────────────

  socket.on('play_again', ({ roomCode }: { roomCode: string }) => {
    const room = rooms[roomCode];
    if (!room || room.gameStarted) return;

    // TODO: Clear previous player coordinates on game reset – re-index after any disconnects
    clearTurnTimer(room);
    room.gameStarted = false;
    room.winners = [];
    room.currentRoll = 0;
    room.stepsRemaining = 0;
    room.turnIndex = 0;
    room.diamond = null;
    room.diamondsRemaining = 0;
    room.boxes = []; // cleared here; new boxes spawn when start_game is called

    assignStartPositions(room);
    room.playerOrder.forEach(id => {
      if (room.players[id]) {
        room.players[id].ready = false;
        room.players[id].won = false;
      }
    });

    io.to(roomCode).emit('game_reset', {
      players: room.players,
      playerOrder: room.playerOrder,
      roomCode,
      sessionLeaderboard: getSessionLeaderboard(room),
      gamesPlayed: room.gamesPlayed,
    });

    console.log(`[Room ${roomCode}] Reset – back to lobby`);
  });

  // ── Set Emoji ────────────────────────────────────────────────────────────

  socket.on('set_emoji', ({ roomCode, emoji }: { roomCode: string; emoji: string }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || !ALLOWED_EMOJIS.has(emoji)) return;
    player.emoji = emoji;
    io.to(roomCode).emit('player_updated', { players: room.players, playerOrder: room.playerOrder });
  });

  // ── Set Tagline ───────────────────────────────────────────────────────────

  socket.on('set_tagline', ({ roomCode, tagline }: { roomCode: string; tagline: string }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    if (tagline !== '' && !ALLOWED_TAGLINES.has(tagline)) return;
    player.tagline = tagline;
    io.to(roomCode).emit('player_updated', { players: room.players, playerOrder: room.playerOrder });
  });

  // ── Send Reaction ────────────────────────────────────────────────────────

  socket.on('send_reaction', ({ roomCode, content }: { roomCode: string; content: string }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    // 2-second per-player rate limit
    const now = Date.now();
    if (now - player.reactionAt < 2000) return;
    player.reactionAt = now;

    // Validate against the combined whitelist
    const isEmoji = ALLOWED_EMOJIS.has(content);
    if (!isEmoji && !ALLOWED_TAGLINES.has(content)) return;

    io.to(roomCode).emit('reaction_received', {
      senderId:    socket.id,
      senderName:  player.name,
      senderEmoji: player.emoji,
      content,
      isEmoji,
    });
  });

  // ── Leave Room ───────────────────────────────────────────────────────────

  socket.on('leave_room', ({ roomCode }: { roomCode: string }) => {
    const player = rooms[roomCode]?.players[socket.id];
    if (!player) return;

    // Cancel any pending grace timer so the slot isn't held after voluntary leave
    if (disconnectTimers[player.sessionId]) {
      clearTimeout(disconnectTimers[player.sessionId]);
      delete disconnectTimers[player.sessionId];
    }

    removePlayerFromRoom(roomCode, socket.id);
    socket.leave(roomCode);
    console.log(`[Room ${roomCode}] "${player.name}" left voluntarily`);
  });

  // ── Reconnect Room ────────────────────────────────────────────────────────

  socket.on('reconnect_room', ({ sessionId, roomCode }: { sessionId: string; roomCode: string }) => {
    const room = rooms[roomCode];
    if (!room) { socket.emit('reconnect_failed', { message: 'Room no longer exists.' }); return; }

    const oldEntry = Object.entries(room.players).find(([, p]) => p.sessionId === sessionId);
    if (!oldEntry) { socket.emit('reconnect_failed', { message: 'Session expired.' }); return; }

    const [oldId, player] = oldEntry;

    if (disconnectTimers[sessionId]) {
      clearTimeout(disconnectTimers[sessionId]);
      delete disconnectTimers[sessionId];
    }

    // Migrate to new socket ID
    delete room.players[oldId];
    player.id = socket.id;
    player.disconnected = false;
    room.players[socket.id] = player;
    room.playerOrder = room.playerOrder.map(id => id === oldId ? socket.id : id);

    socket.join(roomCode);
    console.log(`[Room ${roomCode}] "${player.name}" reconnected`);

    const currentPlayerId = room.playerOrder[room.turnIndex] ?? '';

    socket.emit('reconnected', {
      playerId: socket.id,
      roomCode,
      isHost: player.isHost,
      players: room.players,
      playerOrder: room.playerOrder,
      gameStarted: room.gameStarted,
      diamond: room.diamond,
      diamondsRemaining: room.diamondsRemaining,
      turnIndex: room.turnIndex,
      currentPlayerId,
      stepsRemaining: room.stepsRemaining,
      currentRoll: room.currentRoll,
      winners: room.winners,
      boxes: room.boxes.map(b => ({ id: b.id, pos: b.pos })),
      sessionLeaderboard: getSessionLeaderboard(room),
      gamesPlayed: room.gamesPlayed,
      turnDuration: room.turnDuration,
    });

    socket.to(roomCode).emit('player_reconnected', {
      players: room.players,
      playerOrder: room.playerOrder,
      playerName: player.name,
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);

    for (const [roomCode, room] of Object.entries(rooms)) {
      const player = room.players[socket.id];
      if (!player) continue;

      player.disconnected = true;
      const { sessionId, name } = player;
      const playerId = socket.id;

      console.log(`[Room ${roomCode}] "${name}" disconnected – grace period 60 s`);

      io.to(roomCode).emit('player_disconnected', {
        playerId: socket.id,
        playerName: name,
        players: room.players,
        playerOrder: room.playerOrder,
      });

      disconnectTimers[sessionId] = setTimeout(() => {
        delete disconnectTimers[sessionId];
        console.log(`[Room ${roomCode}] Grace period expired for "${name}" – removing`);
        removePlayerFromRoom(roomCode, playerId);
      }, 60_000);

      break;
    }
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`💎 Diamond Heist server listening on port ${PORT}`);
});
