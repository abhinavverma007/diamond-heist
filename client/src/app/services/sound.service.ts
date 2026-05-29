import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SoundService {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private readonly muteKey   = 'dh_muted';
  private readonly hapticKey = 'dh_haptic_off';
  private readonly voiceKey  = 'dh_voice_on';
  private readonly largeKey  = 'dh_large_mode';

  get isMuted(): boolean     { return localStorage.getItem(this.muteKey)   === '1'; }
  get isHapticOff(): boolean { return localStorage.getItem(this.hapticKey) === '1'; }
  get isVoiceOn(): boolean   { return localStorage.getItem(this.voiceKey)  !== '0'; } // default on
  get isLargeMode(): boolean { return localStorage.getItem(this.largeKey)  === '1'; }

  toggleMute(): boolean {
    const next = !this.isMuted;
    localStorage.setItem(this.muteKey, next ? '1' : '0');
    return next;
  }

  toggleHaptic(): boolean {
    const next = !this.isHapticOff;
    localStorage.setItem(this.hapticKey, next ? '1' : '0');
    return next;
  }

  toggleVoice(): boolean {
    const next = !this.isVoiceOn;
    localStorage.setItem(this.voiceKey, next ? '1' : '0');
    if (!next) this.cancelSpeech();
    return next;
  }

  toggleLargeMode(): boolean {
    const next = !this.isLargeMode;
    localStorage.setItem(this.largeKey, next ? '1' : '0');
    return next;
  }

  // ── Voice announcements via Web Speech API ──────────────────────────────────

  private speak(text: string, interrupt = false): void {
    if (!this.isVoiceOn) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (interrupt) window.speechSynthesis.cancel();
    const u     = new SpeechSynthesisUtterance(text);
    u.rate      = 0.95;
    u.pitch     = 1.0;
    u.volume    = 1.0;
    window.speechSynthesis.speak(u);
  }

  cancelSpeech(): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  announceYourTurn(): void              { this.speak('Your turn!', true); }
  announceTurn(name: string): void      { this.speak(`${name}'s turn`); }
  announceDiamond(name: string): void   { this.speak(`${name} claimed the diamond!`, true); }
  announceSkipped(name: string): void   { this.speak(`${name} was skipped`, true); }
  announceTimeWarning(): void           { this.speak('10 seconds!', true); }
  announceBox(label: string): void      { this.speak(label); }

  /** Call from any user-gesture handler to unlock AudioContext on iOS/Safari. */
  unlock(): void { this.getCtx(); }

  private getCtx(): AudioContext | null {
    if (typeof AudioContext === 'undefined' && typeof (window as any).webkitAudioContext === 'undefined') return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctor() as AudioContext;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private note(freq: number, type: OscillatorType, duration: number, gain = 0.25, delay = 0): void {
    if (this.isMuted) return;
    const ctx = this.getCtx();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.connect(amp);
    amp.connect(ctx.destination);

    osc.type = type;
    osc.frequency.value = freq;

    const t = ctx.currentTime + delay;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.001, t + duration);

    osc.start(t);
    osc.stop(t + duration + 0.01);
  }

  private noise(duration: number, gain = 0.1): void {
    if (this.isMuted) return;
    const ctx = this.getCtx();
    if (!ctx) return;

    if (!this.noiseBuffer || this.noiseBuffer.sampleRate !== ctx.sampleRate) {
      const len  = Math.ceil(ctx.sampleRate * 0.3);
      const buf  = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }

    const src  = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filt       = ctx.createBiquadFilter();
    filt.type        = 'bandpass';
    filt.frequency.value = 300;
    filt.Q.value     = 1;

    const amp = ctx.createGain();
    const t   = ctx.currentTime;
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + duration);

    src.connect(filt);
    filt.connect(amp);
    amp.connect(ctx.destination);

    src.start(t);
    src.stop(t + duration);
  }

  private vibrate(pattern: number | number[]): void {
    if (this.isHapticOff) return;
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch { /* unsupported */ }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Short rattle when the dice starts rolling (call on roll button tap). */
  playRoll(): void {
    this.noise(0.06, 0.12);
    this.vibrate(15);
  }

  /** Descending tones when dice result pops in: E5 → C5 → A4. */
  playLand(): void {
    this.note(659, 'sine', 0.12, 0.28, 0);
    this.note(523, 'sine', 0.12, 0.22, 0.1);
    this.note(440, 'sine', 0.18, 0.18, 0.2);
    this.vibrate([30, 20, 30]);
  }

  /** Ascending arpeggio fanfare on diamond claim: C5 → E5 → G5 → C6. */
  playDiamondClaim(): void {
    this.note(523,  'triangle', 0.15, 0.32, 0);
    this.note(659,  'triangle', 0.15, 0.32, 0.1);
    this.note(784,  'triangle', 0.15, 0.32, 0.2);
    this.note(1047, 'triangle', 0.40, 0.38, 0.3);
    this.vibrate([100, 30, 100, 30, 200]);
  }

  /** Soft bell ping to alert the player it's their turn. */
  playYourTurn(): void {
    this.note(880, 'triangle', 0.22, 0.18);
    this.vibrate(50);
  }
}
