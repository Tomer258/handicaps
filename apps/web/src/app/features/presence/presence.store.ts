import { Injectable, computed, inject, signal } from '@angular/core';
import { SessionService } from '../../core/auth/session.service';
import { PresenceStatus } from '../../shared/ui/avatar';

/** Ephemeral presence per user (aggregated server-side across that user's connections). */
@Injectable({ providedIn: 'root' })
export class PresenceStore {
  private readonly session = inject(SessionService);
  private readonly _status = signal<Record<string, PresenceStatus>>({});

  readonly statusMap = this._status.asReadonly();
  readonly myStatus = computed<PresenceStatus>(() => {
    const id = this.session.userId();
    return (id && this._status()[id]) || 'online';
  });

  status(userId: string): PresenceStatus {
    return this._status()[userId] ?? 'offline';
  }

  set(userId: string, status: PresenceStatus): void {
    this._status.update((m) => ({ ...m, [userId]: status }));
  }

  replace(all: Record<string, PresenceStatus>): void {
    this._status.set(all);
  }
}
