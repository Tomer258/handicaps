import { Injectable, computed, signal } from '@angular/core';

export type VoiceConnection = 'idle' | 'joining' | 'connected' | 'reconnecting' | 'error';

/**
 * Root voice/media session (one LiveKit Room for the whole app). Route components only read its signals;
 * leaving a text route never tears it down. Logout and explicit Leave perform centralized teardown.
 * (Skeleton — LiveKit integration lands in slice S4.)
 */
@Injectable({ providedIn: 'root' })
export class MediaSessionService {
  private readonly _connection = signal<VoiceConnection>('idle');
  private readonly _channelId = signal<string | null>(null);
  private readonly _muted = signal(false);
  private readonly _deafened = signal(false);
  private readonly _speaking = signal<ReadonlySet<string>>(new Set());

  readonly connection = this._connection.asReadonly();
  readonly channelId = this._channelId.asReadonly();
  readonly muted = this._muted.asReadonly();
  readonly deafened = this._deafened.asReadonly();
  readonly speaking = this._speaking.asReadonly();
  readonly connected = computed(() => this._connection() === 'connected' || this._connection() === 'reconnecting');

  toggleMute(): void {
    if (this._deafened() && this._muted()) {
      // Unmuting while deafened also undeafens (documented restore choice).
      this._deafened.set(false);
    }
    this._muted.update((m) => !m);
  }

  toggleDeafen(): void {
    const next = !this._deafened();
    this._deafened.set(next);
    if (next) this._muted.set(true);
  }
}
