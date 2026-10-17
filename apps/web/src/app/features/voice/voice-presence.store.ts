import { Injectable, computed, signal } from '@angular/core';

/** Server-reported voice membership (who is in which room), from REST snapshot + SignalR VoiceStateChanged. */
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
  private readonly _members = signal<VoiceMember[]>([]);
  readonly members = this._members.asReadonly();

  readonly byChannel = computed(() => {
    const map = new Map<string, VoiceMember[]>();
    for (const m of this._members()) {
      const list = map.get(m.channelId) ?? [];
      list.push(m);
      map.set(m.channelId, list);
    }
    return map;
  });

  readonly byUser = computed(() => new Map(this._members().map((m) => [m.userId, m])));

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
}
