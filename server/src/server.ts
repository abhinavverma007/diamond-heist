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
const GRID_SIZE = 15;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  isHost: boolean;
  color: string;
  emoji: string;
  ready: boolean;
  sessionId: string;
  disconnected: boolean;
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

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
const PLAYER_START_POSITIONS: Point[] = [
  { x: 0,             y: 0 },              // top-left
  { x: GRID_SIZE - 1, y: GRID_SIZE - 1 },  // bottom-right
  { x: 0,             y: GRID_SIZE - 1 },  // bottom-left
  { x: GRID_SIZE - 1, y: 0 },              // top-right
  { x: 7,             y: 0 },              // top-center
  { x: 7,             y: GRID_SIZE - 1 },  // bottom-center
  { x: 0,             y: 7 },              // left-center
  { x: GRID_SIZE - 1, y: 7 },              // right-center
  { x: 3,             y: 0 },              // top-left-mid
  { x: 11,            y: GRID_SIZE - 1 },  // bottom-right-mid
];

// ─── In-memory stores ────────────────────────────────────────────────────────

const rooms: Record<string, RoomState> = {};

// Keyed by sessionId – cleared when player reconnects or timer fires
const disconnectTimers: Record<string, ReturnType<typeof setTimeout>> = {};

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

function spawnDiamond(players: Record<string, Player>): Point {
  const MAX_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = 4 + Math.floor(Math.random() * 7); // cols 4–10
    const y = 4 + Math.floor(Math.random() * 7); // rows 4–10
    if (!Object.values(players).some(p => p.x === x && p.y === y)) return { x, y };
  }
  return { x: 7, y: 7 };
}

function removePlayerFromRoom(roomCode: string, playerId: string): void {
  const room = rooms[roomCode];
  if (!room || !room.players[playerId]) return;

  const wasHost = room.players[playerId].isHost;
  delete room.players[playerId];
  room.playerOrder = room.playerOrder.filter(id => id !== playerId);

  if (room.playerOrder.length === 0) {
    delete rooms[roomCode];
    console.log(`[Room ${roomCode}] Empty – deleted`);
    return;
  }

  if (wasHost) room.players[room.playerOrder[0]].isHost = true;

  room.playerOrder.forEach((id, idx) => {
    room.players[id].color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    room.players[id].emoji = PLAYER_EMOJIS[idx % PLAYER_EMOJIS.length];
  });

  io.to(roomCode).emit('player_left', {
    players: room.players,
    playerOrder: room.playerOrder,
  });
}

function advanceTurn(room: RoomState): void {
  room.turnIndex = (room.turnIndex + 1) % room.playerOrder.length;
  room.currentRoll = 0;
  room.stepsRemaining = 0;
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
      x: PLAYER_START_POSITIONS[0].x,
      y: PLAYER_START_POSITIONS[0].y,
      isHost: true,
      color: PLAYER_COLORS[0],
      emoji: PLAYER_EMOJIS[0],
      ready: false,
      sessionId: generateSessionId(),
      disconnected: false,
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
      x: PLAYER_START_POSITIONS[idx % PLAYER_START_POSITIONS.length].x,
      y: PLAYER_START_POSITIONS[idx % PLAYER_START_POSITIONS.length].y,
      isHost: false,
      color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
      emoji: PLAYER_EMOJIS[idx % PLAYER_EMOJIS.length],
      ready: false,
      sessionId: generateSessionId(),
      disconnected: false,
    };

    room.players[socket.id] = player;
    room.playerOrder.push(socket.id);

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

  socket.on('start_game', ({ roomCode, diamondCount }: { roomCode: string; diamondCount?: number }) => {
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
    room.gameStarted = true;
    room.winners = [];
    room.turnIndex = 0;
    room.currentRoll = 0;
    room.stepsRemaining = 0;
    room.diamond = spawnDiamond(room.players);
    room.diamondsRemaining = count;

    const firstId = room.playerOrder[0];

    io.to(roomCode).emit('game_started', {
      players: room.players,
      playerOrder: room.playerOrder,
      diamond: room.diamond,
      diamondsRemaining: room.diamondsRemaining,
      turnIndex: room.turnIndex,
      currentPlayerId: firstId,
      currentPlayerName: room.players[firstId].name,
    });

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

    // Win only when the player lands exactly on the diamond cell – passing through doesn't count
    const hitDiamond = room.diamond && nx === room.diamond.x && ny === room.diamond.y;

    if (hitDiamond) {
      room.diamondsRemaining--;

      const place = room.winners.length + 1;
      const winner: Winner = { id: socket.id, name: player.name, place, emoji: player.emoji };
      room.winners.push(winner);

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
      });

      if (gameOver) {
        io.to(roomCode).emit('game_won', { winners: room.winners, players: room.players });
        console.log(`[Room ${roomCode}] All diamonds claimed. Winners: ${room.winners.map(w => w.name).join(', ')}`);
      } else {
        console.log(`[Room ${roomCode}] "${player.name}" claimed diamond #${place} – ${room.diamondsRemaining} left on cell`);
      }
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
  });

  // ── Play Again ────────────────────────────────────────────────────────────

  socket.on('play_again', ({ roomCode }: { roomCode: string }) => {
    const room = rooms[roomCode];
    if (!room || room.gameStarted) return;

    // TODO: Clear previous player coordinates on game reset – re-index after any disconnects
    room.gameStarted = false;
    room.winners = [];
    room.currentRoll = 0;
    room.stepsRemaining = 0;
    room.turnIndex = 0;
    room.diamond = null;
    room.diamondsRemaining = 0;

    room.playerOrder.forEach((id, index) => {
      const p = room.players[id];
      if (p && index < PLAYER_START_POSITIONS.length) {
        p.x = PLAYER_START_POSITIONS[index].x;
        p.y = PLAYER_START_POSITIONS[index].y;
        p.ready = false; // each player must re-confirm ready for the next match
      }
    });

    io.to(roomCode).emit('game_reset', {
      players: room.players,
      playerOrder: room.playerOrder,
      roomCode,
    });

    console.log(`[Room ${roomCode}] Reset – back to lobby`);
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
