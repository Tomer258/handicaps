import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { UnreadRow } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ChannelBadges } from './channel-badges.service';

const POLL_MS = 60_000;

export interface ServerBadge {
  unread: boolean;
  mentions: number;
}

/**
 * Rail badges per server: the open server sums the live channel badges; the others (and the open
 * one while on Home) come from GET /servers/{id}/unread, refreshed on focus, on mentions and every minute.
 */
@Injectable({ providedIn: 'root' })
export class ServerBadges {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly channels = inject(ChannelBadges);
  private readonly fetched = signal<Record<string, ServerBadge>>({});
  private timer?: ReturnType<typeof setInterval>;
  private gen = 0;

  private readonly live = computed<ServerBadge>(() => {
    const unread = Object.values(this.channels.unreadMap()).some((n) => n > 0);
    const mentions = Object.values(this.channels.mentionMap()).reduce((a, n) => a + n, 0);
    return { unread: unread || mentions > 0, mentions };
  });

  constructor() {
    // Leaving a server (to another one or Home) hands its badge back to the fetched state: refresh it.
    effect(() => {
      this.workspace.serverId();
      untracked(() => { if (this.timer) this.refreshAll(); });
    });
    inject(RealtimeService).onNotification((n) => {
      if (n.serverId !== this.workspace.serverId()) void this.refresh(n.serverId);
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.refreshAll();
      });
    }
    this.session.onTeardown(() => {
      this.gen++;
      clearInterval(this.timer);
      this.timer = undefined;
      this.fetched.set({});
    });
  }

  /** Starts polling once the shell is up (idempotent). */
  start(): void {
    if (this.timer) return;
    this.refreshAll();
    this.timer = setInterval(() => this.refreshAll(), POLL_MS);
  }

  badge(serverId: string): ServerBadge {
    if (serverId === this.workspace.serverId()) return this.live();
    return this.fetched()[serverId] ?? { unread: false, mentions: 0 };
  }

  refreshAll(): void {
    for (const s of this.session.servers()) if (s.id !== this.workspace.serverId()) void this.refresh(s.id);
  }

  private async refresh(serverId: string): Promise<void> {
    const gen = this.gen;
    try {
      const rows = await this.api.get<UnreadRow[]>(`/servers/${serverId}/unread`);
      if (gen !== this.gen) return;
      const mentions = rows.reduce((a, r) => a + r.mentions, 0);
      const unread = rows.some((r) => r.unread > 0) || mentions > 0;
      this.fetched.update((m) => ({ ...m, [serverId]: { unread, mentions } }));
    } catch {
      /* best effort: the next poll corrects it */
    }
  }
}
