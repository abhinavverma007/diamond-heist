import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { interval, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { SocketService } from '../services/socket.service';

// TODO: Implement room code validation before emitting (regex /^[A-Z0-9]{4}$/)
// TODO: Add local-storage persistence for playerName across sessions
// TODO: Show network reconnect banner when socket drops mid-game
// TODO: Animate player token sliding across tiles (CSS translate per step)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  isHost: boolean;
  color: string;
  emoji: string;
  ready: boolean;
  disconnected: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Winner {
  id: string;
  name: string;
  place: number;
  emoji: string;
}

export interface CellData {
  emoji: string;
  extraClass: string;
}

export type GameView = 'setup' | 'lobby' | 'game';
export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-game',
  templateUrl: './game.component.html',
  styleUrls: ['./game.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameComponent implements OnInit, OnDestroy {

  // ── View ────────────────────────────────────────────────────────────────────
  currentView: GameView = 'setup';

  // ── Setup inputs ────────────────────────────────────────────────────────────
  playerName = '';
  joinCodeInput = '';
  errorMsg = '';
  isBusy = false;

  // ── Session ─────────────────────────────────────────────────────────────────
  myId = '';
  roomCode = '';
  isHost = false;
  myReady = false; // tracks whether the local player clicked "I am Ready"

  // ── Players ─────────────────────────────────────────────────────────────────
  players: Record<string, Player> = {};
  playerOrder: string[] = [];

  // ── Live game state ──────────────────────────────────────────────────────────
  diamond: Point | null = null;
  diamondsRemaining = 0;
  winners: Winner[] = [];
  diamondCountInput = 1;
  claimToast = '';
  private claimToastTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWin: { winners: Winner[]; players: Record<string, Player> } | null = null;
  turnIndex = 0;
  currentPlayerId = '';
  currentRoll = 0;
  stepsRemaining = 0;

  // ── Dice animation state ─────────────────────────────────────────────────────
  // 'idle'    → Roll button visible
  // 'rolling' → Dice shaking + cycling numbers
  // 'landed'  → Final number pops in, D-pad appears
  dicePhase: 'idle' | 'rolling' | 'landed' = 'idle';
  rollingDisplay = 1;          // number shown during animation
  private rollStartTime = 0;
  private readonly rollAnimStop$ = new Subject<void>(); // stops the cycling interval

  // ── Move guard ───────────────────────────────────────────────────────────────
  // Prevents double-emitting while server round-trip is in flight
  isMoving = false;

  // ── Hop animation ────────────────────────────────────────────────────────────
  // ID of the player currently being animated step-by-step across the board
  private hoppingPlayerId = '';

  // ── Winner overlay ───────────────────────────────────────────────────────────
  showWinnerModal = false;

  // ── Flat 225-cell array for the 15×15 grid ───────────────────────────────────
  flatCells: CellData[] = [];

  private readonly destroy$ = new Subject<void>();

  constructor(
    private readonly socketService: SocketService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.socketService.connect();
    this.flatCells = Array.from({ length: 225 }, () => ({ emoji: '', extraClass: '' }));
    this.registerSocketListeners();
  }

  ngOnDestroy(): void {
    this.rollAnimStop$.next();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.claimToastTimer) clearTimeout(this.claimToastTimer);
    this.socketService.disconnect();
  }

  // ─── Grid ──────────────────────────────────────────────────────────────────

  private refreshGrid(): void {
    const cells: CellData[] = Array.from({ length: 225 }, (_, i) => ({
      emoji: '',
      // Checkerboard pattern on empty cells for a board-game feel
      extraClass: (Math.floor(i / 15) + (i % 15)) % 2 === 0
        ? 'cell-light'
        : 'cell-dark',
    }));

    if (this.diamond) {
      const dIdx = this.diamond.y * 15 + this.diamond.x;
      if (dIdx >= 0 && dIdx < 225) {
        cells[dIdx] = { emoji: '💎', extraClass: 'board-cell--diamond' };
      }
    }

    for (const id of this.playerOrder) {
      const p = this.players[id];
      if (!p) continue;
      const pIdx = p.y * 15 + p.x;
      if (pIdx < 0 || pIdx >= 225) continue;

      let extraClass = 'board-cell--player';
      if (id === this.currentPlayerId) extraClass = 'board-cell--current';
      if (id === this.myId)            extraClass += ' board-cell--me';
      if (id === this.hoppingPlayerId) extraClass += ' board-cell--hopping';

      cells[pIdx] = { emoji: p.emoji, extraClass };
    }

    this.flatCells = cells;
  }

  // ─── Dice helpers ──────────────────────────────────────────────────────────

  /** Maps 1-6 to Unicode dice face characters. */
  getDiceFace(n: number): string {
    const faces: Record<number, string> = {
      1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅',
    };
    return faces[n] ?? '🎲';
  }

  private resetDiceState(): void {
    this.rollAnimStop$.next();
    this.dicePhase = 'idle';
    this.rollingDisplay = 1;
    this.currentRoll = 0;
  }

  // ─── Template helpers ──────────────────────────────────────────────────────

  get myPlayer(): Player | undefined { return this.players[this.myId]; }
  get isMyTurn(): boolean            { return this.currentPlayerId === this.myId; }

  get canRoll(): boolean {
    return this.isMyTurn && this.stepsRemaining === 0
      && this.dicePhase === 'idle' && !this.showWinnerModal;
  }

  get canMove(): boolean {
    return this.isMyTurn && this.stepsRemaining > 0
      && this.dicePhase === 'landed' && !this.isMoving && !this.showWinnerModal;
  }

  get playerList(): Player[] {
    return this.playerOrder.map(id => this.players[id]).filter((p): p is Player => !!p);
  }

  get currentPlayerName(): string {
    return this.players[this.currentPlayerId]?.name ?? '';
  }

  /** True only when every player in the room has clicked "I am Ready". */
  get allPlayersReady(): boolean {
    const list = this.playerList;
    return list.length >= 2 && list.every(p => p.ready);
  }

  /** Number of players who haven't clicked Ready yet. */
  get notReadyCount(): number {
    return this.playerList.filter(p => !p.ready).length;
  }

  /** Hint text shown below the host's Start Game button when it is disabled. */
  get hostHint(): string {
    if (this.playerList.length < 2) return 'Need at least 2 players to start!';
    if (this.notReadyCount > 0) return `Waiting for ${this.notReadyCount} player(s) to get ready…`;
    return '';
  }

  readonly diamondOptions = [1, 2, 3, 4, 5, 6];

  /** true = still available, false = already claimed. Total = host's chosen count. */
  get diamondSlots(): boolean[] {
    const total = this.winners.length + this.diamondsRemaining;
    return Array.from({ length: total }, (_, i) => i >= this.winners.length);
  }

  get myWinPlace(): number {
    return this.winners.find(w => w.id === this.myId)?.place ?? 0;
  }

  get placeLabel(): string {
    const labels: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th' };
    return labels[this.myWinPlace] ?? '';
  }

  trackByCell(index: number, _: CellData): number          { return index; }
  trackByPlayerId(_: number, player: Player): string        { return player.id; }
  trackByWinner(_: number, w: Winner): string               { return w.id; }

  // ─── Move animation ────────────────────────────────────────────────────────

  /** Walks the moving player one tile at a time, triggering a hop on each cell. */
  private animateMove(
    movingId: string,
    finalPlayers: Record<string, Player>,
    stepsRemaining: number,
    turnIndex: number,
    currentPlayerId: string,
    turnChanged: boolean,
  ): void {
    const from = this.players[movingId];
    const to   = finalPlayers[movingId];

    if (!from || !to) {
      this.applyMoveState(finalPlayers, stepsRemaining, turnIndex, currentPlayerId, turnChanged);
      return;
    }

    const dx         = to.x - from.x;
    const dy         = to.y - from.y;
    const totalSteps = Math.abs(dx) + Math.abs(dy);

    if (totalSteps === 0) {
      this.applyMoveState(finalPlayers, stepsRemaining, turnIndex, currentPlayerId, turnChanged);
      return;
    }

    const stepX = dx !== 0 ? Math.sign(dx) : 0;
    const stepY = dy !== 0 ? Math.sign(dy) : 0;

    this.hoppingPlayerId = movingId;
    let step = 0;

    const hop = () => {
      step++;
      this.players = {
        ...this.players,
        [movingId]: { ...this.players[movingId], x: from.x + stepX * step, y: from.y + stepY * step },
      };
      this.refreshGrid();
      this.cdr.markForCheck();

      if (step < totalSteps) {
        setTimeout(hop, 150);
      } else {
        this.hoppingPlayerId = '';
        this.applyMoveState(finalPlayers, stepsRemaining, turnIndex, currentPlayerId, turnChanged);
      }
    };

    hop();
  }

  private applyMoveState(
    players: Record<string, Player>,
    stepsRemaining: number,
    turnIndex: number,
    currentPlayerId: string,
    turnChanged: boolean,
  ): void {
    this.players         = players;
    this.stepsRemaining  = stepsRemaining;
    this.turnIndex       = turnIndex;
    this.currentPlayerId = currentPlayerId;
    this.isMoving        = false;
    if (turnChanged) this.resetDiceState();

    if (this.pendingWin) {
      const pw = this.pendingWin;
      this.pendingWin = null;
      this.winners  = pw.winners;
      this.showWinnerModal = true;
      this.isMoving = false;
      this.resetDiceState();
    }

    this.refreshGrid();
    this.cdr.markForCheck();
  }

  // ─── Socket listeners ──────────────────────────────────────────────────────

  private registerSocketListeners(): void {

    this.socketService
      .on<{ roomCode: string; playerId: string; sessionId: string; player: Player; players: Record<string, Player>; playerOrder: string[] }>('room_created')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.myId = data.playerId; this.roomCode = data.roomCode;
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.isHost = true; this.isBusy = false; this.currentView = 'lobby';
        this.socketService.saveSession(data.sessionId, data.roomCode);
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ roomCode: string; playerId: string; sessionId: string; player: Player; players: Record<string, Player>; playerOrder: string[] }>('room_joined')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.myId = data.playerId; this.roomCode = data.roomCode;
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.isHost = false; this.isBusy = false; this.currentView = 'lobby';
        this.socketService.saveSession(data.sessionId, data.roomCode);
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[] }>('player_joined')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.cdr.markForCheck();
      });

    // A player toggled their ready status – only update the shared players map.
    // myReady is a local one-way flag; never read it back from this snapshot
    // because the snapshot may predate our own ready_up confirmation.
    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[] }>('player_ready_update')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[]; diamond: Point; diamondsRemaining: number; turnIndex: number; currentPlayerId: string }>('game_started')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.diamond = data.diamond; this.diamondsRemaining = data.diamondsRemaining;
        this.winners = []; this.turnIndex = data.turnIndex;
        this.currentPlayerId = data.currentPlayerId;
        this.stepsRemaining = 0; this.showWinnerModal = false;
        this.isMoving = false; this.myReady = false; this.currentView = 'game';
        this.resetDiceState();
        this.refreshGrid();
        this.cdr.markForCheck();
      });

    // ── Dice rolled: wait for minimum animation time before revealing ─────────
    this.socketService
      .on<{ roll: number; stepsRemaining: number; currentPlayerId: string }>('dice_rolled')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        // TODO: Add dice-landed sound effect here (Web Audio API)
        const elapsed = Date.now() - this.rollStartTime;
        const minAnim = 800; // ms – minimum roll duration so it feels satisfying
        const delay = Math.max(0, minAnim - elapsed);

        setTimeout(() => {
          this.rollAnimStop$.next();        // stop cycling interval
          this.currentRoll    = data.roll;
          this.rollingDisplay = data.roll;
          this.stepsRemaining = data.stepsRemaining;
          this.dicePhase      = 'landed';
          this.cdr.markForCheck();
        }, delay);
      });

    // ── Player moved: animate step-by-step, then advance turn ────────────────
    this.socketService
      .on<{ players: Record<string, Player>; stepsRemaining: number; turnIndex: number; currentPlayerId: string; turnChanged: boolean }>('player_moved')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        const movingId = this.currentPlayerId;
        this.animateMove(movingId, data.players, data.stepsRemaining, data.turnIndex, data.currentPlayerId, data.turnChanged);
      });

    this.socketService
      .on<{ winner: Winner; diamond: Point | null; remainingCount: number; players: Record<string, Player>; stepsRemaining: number; turnIndex: number; currentPlayerId: string; turnChanged: boolean; gameOver: boolean }>('diamond_claimed')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        const movingId = this.currentPlayerId;
        this.diamond = data.diamond;
        this.diamondsRemaining = data.remainingCount;

        if (this.claimToastTimer) clearTimeout(this.claimToastTimer);
        const ordinal = ['1st', '2nd', '3rd', '4th', '5th', '6th'][data.winner.place - 1] ?? `#${data.winner.place}`;
        const left = data.remainingCount > 0 ? ` (${data.remainingCount} left)` : '';
        this.claimToast = `${data.winner.emoji} ${data.winner.name} grabbed the ${ordinal} diamond!${left}`;
        this.claimToastTimer = setTimeout(() => { this.claimToast = ''; this.cdr.markForCheck(); }, 3000);

        this.animateMove(movingId, data.players, data.stepsRemaining, data.turnIndex, data.currentPlayerId, data.turnChanged);
      });

    this.socketService
      .on<{ winners: Winner[]; players: Record<string, Player> }>('game_won')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        if (this.hoppingPlayerId) {
          this.pendingWin = data;
        } else {
          this.winners = data.winners;
          this.players = data.players;
          this.showWinnerModal = true;
          this.isMoving = false;
          this.resetDiceState();
          this.refreshGrid();
          this.cdr.markForCheck();
        }
      });

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[]; roomCode: string }>('game_reset')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.currentView = 'lobby'; this.showWinnerModal = false;
        this.winners = []; this.diamond = null; this.diamondsRemaining = 0;
        this.stepsRemaining = 0; this.isMoving = false;
        this.myReady = false; this.diamondCountInput = 1;
        this.resetDiceState();
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[] }>('player_left')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        if (this.players[this.myId]?.isHost) this.isHost = true;
        if (this.currentView === 'game') this.refreshGrid();
        this.cdr.markForCheck();
      });

    // ── Reconnected: restore full state after socket drop ────────────────────
    this.socketService
      .on<{ playerId: string; roomCode: string; isHost: boolean; players: Record<string, Player>; playerOrder: string[]; gameStarted: boolean; diamond: Point | null; diamondsRemaining: number; turnIndex: number; currentPlayerId: string; stepsRemaining: number; currentRoll: number; winners: Winner[] }>('reconnected')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.myId = data.playerId; this.roomCode = data.roomCode; this.isHost = data.isHost;
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.winners = data.winners; this.isBusy = false;

        if (data.gameStarted) {
          this.diamond = data.diamond; this.diamondsRemaining = data.diamondsRemaining;
          this.turnIndex = data.turnIndex; this.currentPlayerId = data.currentPlayerId;
          this.stepsRemaining = data.stepsRemaining; this.currentRoll = data.currentRoll;
          this.currentView = 'game';
          if (data.stepsRemaining === 0) this.resetDiceState();
          this.refreshGrid();
        } else if (data.winners.length > 0) {
          this.showWinnerModal = true; this.currentView = 'game';
          this.refreshGrid();
        } else {
          this.currentView = 'lobby';
        }
        this.cdr.markForCheck();
      });

    this.socketService.on<{ message: string }>('reconnect_failed')
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.socketService.clearSession();
        this.currentView = 'setup'; this.isBusy = false;
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ playerId: string; playerName: string; players: Record<string, Player>; playerOrder: string[] }>('player_disconnected')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.errorMsg = `⚡ ${data.playerName} lost connection – waiting up to 60 s…`;
        setTimeout(() => { this.errorMsg = ''; this.cdr.markForCheck(); }, 8000);
        if (this.currentView === 'game') this.refreshGrid();
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[]; playerName: string }>('player_reconnected')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.errorMsg = `✅ ${data.playerName} reconnected!`;
        setTimeout(() => { this.errorMsg = ''; this.cdr.markForCheck(); }, 3000);
        if (this.currentView === 'game') this.refreshGrid();
        this.cdr.markForCheck();
      });

    this.socketService.on<{ message: string }>('join_error')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.errorMsg = data.message; this.isBusy = false;
        this.cdr.markForCheck();
        setTimeout(() => { this.errorMsg = ''; this.cdr.markForCheck(); }, 4000);
      });

    this.socketService.on<{ message: string }>('game_error')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.errorMsg = data.message;
        this.cdr.markForCheck();
        setTimeout(() => { this.errorMsg = ''; this.cdr.markForCheck(); }, 3000);
      });
  }

  // ─── User actions ──────────────────────────────────────────────────────────

  createRoom(): void {
    if (!this.playerName.trim() || this.isBusy) return;
    this.socketService.clearSession();
    this.errorMsg = ''; this.isBusy = true;
    this.socketService.emit('create_room', { playerName: this.playerName.trim() });
  }

  joinRoom(): void {
    const code = this.joinCodeInput.toUpperCase().trim();
    if (!this.playerName.trim() || code.length < 4 || this.isBusy) return;
    this.socketService.clearSession();
    this.errorMsg = ''; this.isBusy = true;
    this.socketService.emit('join_room', { roomCode: code, playerName: this.playerName.trim() });
  }

  readyUp(): void {
    if (this.myReady) return; // idempotent – can't un-ready
    this.myReady = true;

    // Optimistically flip the chip in the player list immediately —
    // don't wait for the server round-trip (player_ready_update) to update it.
    if (this.players[this.myId]) {
      this.players = {
        ...this.players,
        [this.myId]: { ...this.players[this.myId], ready: true },
      };
    }

    this.socketService.emit('ready_up', { roomCode: this.roomCode });
    this.cdr.markForCheck();
  }

  startGame(): void {
    if (!this.isHost || !this.allPlayersReady) return;
    this.socketService.emit('start_game', { roomCode: this.roomCode, diamondCount: this.diamondCountInput });
  }

  rollDice(): void {
    if (!this.canRoll) return;

    this.dicePhase     = 'rolling';
    this.rollStartTime = Date.now();
    this.socketService.emit('roll_dice', { roomCode: this.roomCode });

    // Cycle random dice faces every 80ms until server responds
    // TODO: Add haptic feedback here (navigator.vibrate) for mobile
    interval(80)
      .pipe(takeUntil(this.rollAnimStop$), takeUntil(this.destroy$))
      .subscribe(() => {
        this.rollingDisplay = Math.floor(Math.random() * 6) + 1;
        this.cdr.markForCheck();
      });
  }

  /** One direction click moves ALL rolled steps – no step counting on the client. */
  move(direction: Direction): void {
    if (!this.canMove) return;
    this.isMoving = true; // prevents double-tap until server confirms
    this.socketService.emit('move_player', { roomCode: this.roomCode, direction });
    this.cdr.markForCheck();
  }

  playAgain(): void {
    this.socketService.emit('play_again', { roomCode: this.roomCode });
  }

  copyRoomCode(): void {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(this.roomCode).catch(() => {});
    }
  }
}
