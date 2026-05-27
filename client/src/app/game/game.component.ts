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
import { SoundService } from '../services/sound.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  x: number;
  y: number;
  isHost: boolean;
  color: string;
  emoji: string;
  tagline: string;
  ready: boolean;
  disconnected: boolean;
  won: boolean;
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

export interface Box {
  id: number;
  pos: Point;
}

export interface SessionEntry {
  playerId: string;
  name: string;
  emoji: string;
  score: number;
}

export interface CellData {
  emoji: string;
  extraClass: string;
  stackCount?: number;
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

  // ── Mystery boxes ────────────────────────────────────────────────────────────
  boxes: Box[] = [];

  // ── Session leaderboard ──────────────────────────────────────────────────────
  sessionLeaderboard: SessionEntry[] = [];
  gamesPlayed = 0;

  // ── Box reveal overlay ───────────────────────────────────────────────────────
  isBoxRevealOpen = false;
  boxRevealData: { emoji: string; label: string; pointsDelta: number; openerName: string } | null = null;
  private boxRevealTimer: ReturnType<typeof setTimeout> | null = null;

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

  // ── Sound / haptic toggles (reflected in template) ──────────────────────────
  get isMuted(): boolean     { return this.sound.isMuted; }
  get isHapticOff(): boolean { return this.sound.isHapticOff; }

  toggleMute(): void    { this.sound.toggleMute();    this.cdr.markForCheck(); }
  toggleHaptic(): void  { this.sound.toggleHaptic();  this.cdr.markForCheck(); }

  constructor(
    private readonly socketService: SocketService,
    private readonly cdr: ChangeDetectorRef,
    private readonly sound: SoundService,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.socketService.connect();
    this.flatCells = Array.from({ length: this.G * this.G }, () => ({ emoji: '', extraClass: '' }));
    this.registerSocketListeners();
  }

  ngOnDestroy(): void {
    this.rollAnimStop$.next();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.claimToastTimer) clearTimeout(this.claimToastTimer);
    if (this.boxRevealTimer) clearTimeout(this.boxRevealTimer);
    this.socketService.disconnect();
  }

  // ─── Grid ──────────────────────────────────────────────────────────────────

  private readonly G = 21;

  private refreshGrid(): void {
    const G = this.G;
    const cells: CellData[] = Array.from({ length: G * G }, (_, i) => ({
      emoji: '',
      extraClass: (Math.floor(i / G) + (i % G)) % 2 === 0 ? 'cell-light' : 'cell-dark',
    }));

    if (this.diamond) {
      const dIdx = this.diamond.y * G + this.diamond.x;
      if (dIdx >= 0 && dIdx < G * G) {
        cells[dIdx] = { emoji: '💎', extraClass: 'board-cell--diamond' };
      }
    }

    for (const box of this.boxes) {
      const bIdx = box.pos.y * G + box.pos.x;
      if (bIdx >= 0 && bIdx < G * G && cells[bIdx].emoji === '') {
        cells[bIdx] = { emoji: '🎁', extraClass: 'board-cell--box' };
      }
    }

    // Build map: cell index → [playerIds] (skip won players — they're off the board)
    const cellMap = new Map<number, string[]>();
    for (const id of this.playerOrder) {
      const p = this.players[id];
      if (!p || p.won) continue;
      const pIdx = p.y * G + p.x;
      if (pIdx < 0 || pIdx >= G * G) continue;
      if (!cellMap.has(pIdx)) cellMap.set(pIdx, []);
      cellMap.get(pIdx)!.push(id);
    }

    for (const [pIdx, ids] of cellMap.entries()) {
      // Priority: my piece > current player > hopping player > last in list
      let topId = ids[ids.length - 1];
      if (ids.includes(this.currentPlayerId)) topId = this.currentPlayerId;
      if (ids.includes(this.myId))            topId = this.myId;
      if (ids.includes(this.hoppingPlayerId)) topId = this.hoppingPlayerId;

      const p = this.players[topId];
      let extraClass = 'board-cell--player';
      if (topId === this.currentPlayerId) extraClass = 'board-cell--current';
      if (topId === this.myId)            extraClass += ' board-cell--me';
      if (topId === this.hoppingPlayerId) extraClass += ' board-cell--hopping';

      cells[pIdx] = {
        emoji: p.emoji,
        extraClass,
        stackCount: ids.length > 1 ? ids.length : undefined,
      };
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

  // ── Reaction panel ───────────────────────────────────────────────────────────
  isReactionPanelOpen = false;

  // Each in-flight balloon: id for trackBy, content, left-% position, isEmoji flag, sender name
  activeReactions: { id: number; content: string; x: number; isEmoji: boolean; senderName: string }[] = [];
  private reactionCounter = 0;

  toggleReactionPanel(): void  { this.isReactionPanelOpen = !this.isReactionPanelOpen; this.cdr.markForCheck(); }
  closeReactionPanel(): void   { this.isReactionPanelOpen = false;  this.cdr.markForCheck(); }

  sendReaction(content: string): void {
    this.isReactionPanelOpen = false;
    this.socketService.emit('send_reaction', { roomCode: this.roomCode, content });
    this.cdr.markForCheck();
  }

  trackByReaction(_: number, r: { id: number }): number { return r.id; }

  // ── Customizer (lobby emoji + tagline picker) ────────────────────────────────
  isCustomizerOpen = false;

  readonly EMOJI_OPTIONS = [
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
  ];

  readonly TAGLINE_OPTIONS = [
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
  ];

  openCustomizer(): void  { this.isCustomizerOpen = true;  this.cdr.markForCheck(); }
  closeCustomizer(): void { this.isCustomizerOpen = false; this.cdr.markForCheck(); }

  selectEmoji(emoji: string): void {
    if (!this.myId || !this.players[this.myId]) return;
    this.players = { ...this.players, [this.myId]: { ...this.players[this.myId], emoji } };
    this.socketService.emit('set_emoji', { roomCode: this.roomCode, emoji });
    this.cdr.markForCheck();
  }

  selectTagline(tagline: string): void {
    if (!this.myId || !this.players[this.myId]) return;
    this.players = { ...this.players, [this.myId]: { ...this.players[this.myId], tagline } };
    this.socketService.emit('set_tagline', { roomCode: this.roomCode, tagline });
    this.cdr.markForCheck();
  }

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
    onComplete?: () => void,
  ): void {
    const from = this.players[movingId];
    const to   = finalPlayers[movingId];

    if (!from || !to) {
      this.applyMoveState(finalPlayers, stepsRemaining, turnIndex, currentPlayerId, turnChanged);
      onComplete?.();
      return;
    }

    const dx         = to.x - from.x;
    const dy         = to.y - from.y;
    const totalSteps = Math.abs(dx) + Math.abs(dy);

    if (totalSteps === 0) {
      this.applyMoveState(finalPlayers, stepsRemaining, turnIndex, currentPlayerId, turnChanged);
      onComplete?.();
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
        onComplete?.();
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
    if (turnChanged) {
      this.resetDiceState();
      if (currentPlayerId === this.myId) this.sound.playYourTurn();
    }

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

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[] }>('player_updated')
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
      .on<{ players: Record<string, Player>; playerOrder: string[]; diamond: Point; diamondsRemaining: number; turnIndex: number; currentPlayerId: string; boxes: Box[]; sessionLeaderboard: SessionEntry[]; gamesPlayed: number }>('game_started')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.diamond = data.diamond; this.diamondsRemaining = data.diamondsRemaining;
        this.winners = []; this.turnIndex = data.turnIndex;
        this.currentPlayerId = data.currentPlayerId;
        this.stepsRemaining = 0; this.showWinnerModal = false;
        this.isMoving = false; this.myReady = false; this.currentView = 'game';
        this.boxes = data.boxes ?? [];
        this.sessionLeaderboard = data.sessionLeaderboard ?? [];
        this.gamesPlayed = data.gamesPlayed ?? 0;
        this.isBoxRevealOpen = false;
        this.resetDiceState();
        this.refreshGrid();
        if (data.currentPlayerId === this.myId) this.sound.playYourTurn();
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
          this.sound.playLand();
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
      .on<{ winner: Winner; diamond: Point | null; remainingCount: number; players: Record<string, Player>; stepsRemaining: number; turnIndex: number; currentPlayerId: string; turnChanged: boolean; gameOver: boolean; sessionLeaderboard: SessionEntry[] }>('diamond_claimed')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        const movingId = this.currentPlayerId;
        this.diamond = data.diamond;
        this.diamondsRemaining = data.remainingCount;
        if (data.sessionLeaderboard) this.sessionLeaderboard = data.sessionLeaderboard;

        this.sound.playDiamondClaim();
        if (this.claimToastTimer) clearTimeout(this.claimToastTimer);
        const ordinal = ['1st', '2nd', '3rd', '4th', '5th', '6th'][data.winner.place - 1] ?? `#${data.winner.place}`;
        const left = data.remainingCount > 0 ? ` (${data.remainingCount} left)` : '';
        this.claimToast = `${data.winner.emoji} ${data.winner.name} grabbed the ${ordinal} diamond!${left}`;
        this.claimToastTimer = setTimeout(() => { this.claimToast = ''; this.cdr.markForCheck(); }, 3000);

        this.animateMove(movingId, data.players, data.stepsRemaining, data.turnIndex, data.currentPlayerId, data.turnChanged);
      });

    this.socketService
      .on<{ winners: Winner[]; players: Record<string, Player>; sessionLeaderboard: SessionEntry[]; gamesPlayed: number }>('game_won')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        if (data.sessionLeaderboard) this.sessionLeaderboard = data.sessionLeaderboard;
        if (data.gamesPlayed) this.gamesPlayed = data.gamesPlayed;
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
      .on<{ players: Record<string, Player>; playerOrder: string[]; roomCode: string; sessionLeaderboard: SessionEntry[]; gamesPlayed: number }>('game_reset')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.currentView = 'lobby'; this.showWinnerModal = false;
        this.winners = []; this.diamond = null; this.diamondsRemaining = 0;
        this.stepsRemaining = 0; this.isMoving = false;
        this.myReady = false; this.diamondCountInput = 1;
        this.boxes = [];
        if (data.sessionLeaderboard) this.sessionLeaderboard = data.sessionLeaderboard;
        if (data.gamesPlayed) this.gamesPlayed = data.gamesPlayed;
        this.isBoxRevealOpen = false;
        this.resetDiceState();
        this.cdr.markForCheck();
      });

    this.socketService
      .on<{ players: Record<string, Player>; playerOrder: string[]; turnIndex: number; currentPlayerId: string; sessionLeaderboard: SessionEntry[] }>('player_left')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.players = data.players; this.playerOrder = data.playerOrder;
        if (this.players[this.myId]?.isHost) this.isHost = true;
        if (data.sessionLeaderboard) this.sessionLeaderboard = data.sessionLeaderboard;
        if (this.currentView === 'game') {
          // Sync turn state so no one is stuck waiting for the departed player
          if (data.turnIndex !== undefined) this.turnIndex = data.turnIndex;
          if (data.currentPlayerId) {
            this.currentPlayerId = data.currentPlayerId;
            if (data.currentPlayerId === this.myId) {
              this.resetDiceState();
              this.sound.playYourTurn();
            }
          }
          this.refreshGrid();
        }
        this.cdr.markForCheck();
      });

    // ── Reconnected: restore full state after socket drop ────────────────────
    this.socketService
      .on<{ playerId: string; roomCode: string; isHost: boolean; players: Record<string, Player>; playerOrder: string[]; gameStarted: boolean; diamond: Point | null; diamondsRemaining: number; turnIndex: number; currentPlayerId: string; stepsRemaining: number; currentRoll: number; winners: Winner[]; boxes: Box[]; sessionLeaderboard: SessionEntry[]; gamesPlayed: number }>('reconnected')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.myId = data.playerId; this.roomCode = data.roomCode; this.isHost = data.isHost;
        this.players = data.players; this.playerOrder = data.playerOrder;
        this.winners = data.winners; this.isBusy = false;
        this.boxes = data.boxes ?? [];
        this.sessionLeaderboard = data.sessionLeaderboard ?? [];
        this.gamesPlayed = data.gamesPlayed ?? 0;

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

    this.socketService
      .on<{ boxId: number; outcome: string; label: string; emoji: string; pointsDelta: number; openerName: string; openerEmoji: string; players: Record<string, Player>; stepsRemaining: number; turnIndex: number; currentPlayerId: string; currentPlayerName: string; turnChanged: boolean; sessionLeaderboard: SessionEntry[] }>('box_opened')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        const movingId = this.currentPlayerId;
        this.boxes = this.boxes.filter(b => b.id !== data.boxId);
        this.sessionLeaderboard = data.sessionLeaderboard ?? this.sessionLeaderboard;

        // Wait for hop animation to finish, THEN show the reveal modal for 5 s
        this.animateMove(
          movingId, data.players, data.stepsRemaining,
          data.turnIndex, data.currentPlayerId, data.turnChanged,
          () => {
            if (this.boxRevealTimer) clearTimeout(this.boxRevealTimer);
            this.boxRevealData = {
              emoji: data.emoji,
              label: data.label,
              pointsDelta: data.pointsDelta,
              openerName: data.openerName,
            };
            this.isBoxRevealOpen = true;
            this.cdr.markForCheck();
            this.boxRevealTimer = setTimeout(() => {
              this.isBoxRevealOpen = false;
              this.cdr.markForCheck();
            }, 5000);
          },
        );
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

    this.socketService
      .on<{ senderId: string; senderName: string; senderEmoji: string; content: string; isEmoji: boolean }>('reaction_received')
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        const id = ++this.reactionCounter;
        const x  = 10 + Math.random() * 65; // 10–75 % from left edge
        this.activeReactions = [
          ...this.activeReactions,
          { id, content: data.content, x, isEmoji: data.isEmoji, senderName: data.senderName },
        ];
        this.cdr.markForCheck();
        setTimeout(() => {
          this.activeReactions = this.activeReactions.filter(r => r.id !== id);
          this.cdr.markForCheck();
        }, 3200); // slightly longer than the 3s CSS animation
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
    this.sound.unlock();
    this.sound.playRoll();
    this.socketService.emit('roll_dice', { roomCode: this.roomCode });

    // Cycle random dice faces every 80ms until server responds
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

  leaveRoom(): void {
    if (this.roomCode) {
      this.socketService.emit('leave_room', { roomCode: this.roomCode });
    }
    this.socketService.clearSession();
    this.currentView = 'setup';
    this.roomCode = ''; this.myId = ''; this.isHost = false;
    this.players = {}; this.playerOrder = [];
    this.myReady = false; this.isBusy = false; this.errorMsg = '';
    this.showWinnerModal = false; this.winners = [];
    this.diamond = null; this.diamondsRemaining = 0;
    this.stepsRemaining = 0; this.isMoving = false;
    this.hoppingPlayerId = '';
    this.boxes = []; this.sessionLeaderboard = []; this.gamesPlayed = 0;
    this.isBoxRevealOpen = false; this.boxRevealData = null;
    this.resetDiceState();
    this.refreshGrid();
    this.cdr.markForCheck();
  }

  copyRoomCode(): void {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(this.roomCode).catch(() => {});
    }
  }
}
