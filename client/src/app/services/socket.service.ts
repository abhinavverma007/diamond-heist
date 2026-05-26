import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, Subject } from 'rxjs';

// TODO: Implement WebSocket Connection Error Handling – show a reconnecting banner
//       on socket.on('connect_error'), retry with exponential backoff up to ~30s.
// TODO: Add latency indicator (ping measurement via round-trip timestamp).

function resolveServerUrl(): string {
  const hostname = window.location.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLocal) return 'http://localhost:3001';
  // TODO: Replace the placeholder below with your actual Render deploy URL before deploying
  return 'https://diamond-heist.onrender.com';
}

@Injectable({
  providedIn: 'root',
})
export class SocketService implements OnDestroy {
  private socket: Socket;
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly zone: NgZone) {
    this.socket = io(resolveServerUrl(), {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Connected:', this.socket.id);
      this.tryReconnect();
    });
    this.socket.on('disconnect', (reason) =>
      console.warn('[Socket] Disconnected:', reason)
    );
    this.socket.on('connect_error', (err) =>
      console.error('[Socket] Error:', err.message)
    );
  }

  connect(): void {
    if (!this.socket.connected) {
      this.socket.connect();
    }
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  /** Emit an event with optional payload to the server. */
  emit(event: string, data?: unknown): void {
    this.socket.emit(event, data);
  }

  /**
   * Returns a cold Observable that emits on every matching server event.
   * Listener is cleaned up automatically when the Observable is unsubscribed.
   */
  on<T = unknown>(event: string): Observable<T> {
    return new Observable<T>((observer) => {
      const handler = (data: T) => this.zone.run(() => observer.next(data));
      this.socket.on(event, handler);
      return () => this.socket.off(event, handler);
    });
  }

  private readonly sessionKey = 'dh_session';

  saveSession(sessionId: string, roomCode: string): void {
    localStorage.setItem(this.sessionKey, JSON.stringify({ sessionId, roomCode }));
  }

  clearSession(): void {
    localStorage.removeItem(this.sessionKey);
  }

  private tryReconnect(): void {
    const raw = localStorage.getItem(this.sessionKey);
    if (!raw) return;
    try {
      const { sessionId, roomCode } = JSON.parse(raw);
      if (sessionId && roomCode) {
        console.log('[Socket] Attempting session restore for room', roomCode);
        this.socket.emit('reconnect_room', { sessionId, roomCode });
      }
    } catch {
      localStorage.removeItem(this.sessionKey);
    }
  }

  get id(): string {
    return this.socket.id ?? '';
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.socket.disconnect();
  }
}
