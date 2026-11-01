import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Server-reported voice membership (who is in which room), from REST snapshot + SignalR voiceStateChanged. */
export interface VoiceMember {
  userId: string;
  channelId: string;
  muted: boolean;
  deafened: boolean;
  serverMuted: boolean;
  camera: boolean;
  screen: boolean;
  joinedAt: string;
}

@Injectable({ providedIn: 'root' })
export class VoicePresenceStore {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly media = inject(MediaSessionService);

  private readonly _members = signal<VoiceMember[]>([]);
  /**
   * The server's roster, except my own entry follows this tab's call at once: the server only lists me after LiveKit
   * confirmed the connection, so a switch used to leave me under the old room until then.
   */
  readonly members = computed(() => {
    const list = this._members();
    const me = this.session.userId();
    const state = this.media.connection();
    const channelId = this.media.channelId();
    if (!me || !channelId || (state !== 'joining' && state !== 'connected' && state !== 'reconnecting')) return list;
    const server = list.find((m) => m.userId === me);
    if (server?.channelId === channelId) return list;
    const mine: VoiceMember = {
      userId: me, channelId, muted: this.media.muted() || this.media.deafened(), deafened: this.media.deafened(), serverMuted: false,
      camera: false, screen: false, joinedAt: server?.joinedAt ?? new Date().toISOString(),
    };
    return [...list.filter((m) => m.userId !== me), mine];
  });
  private loadSeq = 0;

  readonly byChannel = computed(() => {
    const map = new Map<string, VoiceMember[]>();
    for (const m of this.members()) {
      const list = map.get(m.channelId) ?? [];
      list.push(m);
      map.set(m.channelId, list);
    }
    return map;
  });

  readonly byUser = computed(() => new Map(this.members().map((m) => [m.userId, m])));

  constructor() {
    effect(() => {
      const serverId = this.workspace.serverId();
      untracked(() => (serverId ? void this.load(serverId) : this._members.set([])));
    });
    // Snapshot after reconnect/policy change: pushes may have been missed meanwhile.
    this.realtime.onResubscribe(() => {
      const id = this.workspace.serverId();
      if (id) void this.load(id);
    });
    this.realtime.onVoiceState((v) => {
      if (v.serverId !== this.workspace.serverId()) return;
      if (v.state) this.upsert(v.state);
      else this.remove(v.userId);
    });
    this.session.onTeardown(() => this._members.set([]));
  }

  inChannel(channelId: string): VoiceMember[] {
    return this.byChannel().get(channelId) ?? [];
  }

  replace(all: VoiceMember[]): void {
    this._members.set(all);
  }

  upsert(m: VoiceMember): void {
    this._members.update((list) => [...list.filter((x) => x.userId !== m.userId), m]);
  }

  remove(userId: string): void {
    this._members.update((list) => list.filter((x) => x.userId !== userId));
  }

  private async load(serverId: string): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const list = await this.api.get<VoiceMember[]>(`/servers/${serverId}/voice`);
      if (seq === this.loadSeq && this.workspace.serverId() === serverId) this._members.set(list);
    } catch {
      /* roster is best effort; the next push or reconnect refreshes it */
    }
  }
}
