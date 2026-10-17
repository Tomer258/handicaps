import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { Channel, Member, ServerDetail, has, Perm } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';

/**
 * Root store for the selected workspace: server detail (channels + roles + my permissions) and members.
 * Readonly signals out; mutations only through methods. Realtime events patch this store (S3).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);

  private readonly _server = signal<ServerDetail | null>(null);
  private readonly _members = signal<Member[]>([]);
  private readonly _loading = signal(false);
  private loadSeq = 0;

  readonly server = this._server.asReadonly();
  readonly members = this._members.asReadonly();
  readonly loading = this._loading.asReadonly();

  readonly serverId = computed(() => this._server()?.id ?? null);
  readonly channels = computed(() => this._server()?.channels ?? []);
  readonly textChannels = computed(() => this.channels().filter((c) => c.type === 'text'));
  readonly voiceChannels = computed(() => this.channels().filter((c) => c.type === 'voice'));
  readonly myPermissions = computed(() => this._server()?.myPermissions ?? 0);
  readonly canManageChannels = computed(() => has(this.myPermissions(), Perm.ManageChannels));
  readonly canManageInvites = computed(() => has(this.myPermissions(), Perm.ManageInvites));
  readonly isAdmin = computed(() => has(this.myPermissions(), Perm.Administrator));
  readonly memberById = computed(() => new Map(this._members().map((m) => [m.userId, m])));

  constructor() {
    this.session.onTeardown(() => {
      this._server.set(null);
      this._members.set([]);
    });
  }

  channel(id: string | null | undefined): Channel | undefined {
    return id ? this.channels().find((c) => c.id === id) : undefined;
  }

  /** Loads (or reloads) a server. Stale responses from an older selection are discarded. */
  async select(serverId: string, force = false): Promise<void> {
    if (!force && this._server()?.id === serverId) return;
    const seq = ++this.loadSeq;
    this._loading.set(true);
    try {
      const [detail, members] = await Promise.all([
        this.api.get<ServerDetail>(`/servers/${serverId}`),
        this.api.get<Member[]>(`/servers/${serverId}/members`),
      ]);
      if (seq !== this.loadSeq) return;
      this._server.set(detail);
      this._members.set(members);
    } finally {
      if (seq === this.loadSeq) this._loading.set(false);
    }
  }

  clearSelection(): void {
    this.loadSeq++;
    this._server.set(null);
    this._members.set([]);
  }

  async reload(): Promise<void> {
    const id = this.serverId();
    if (id) await this.select(id, true);
  }

  async reloadMembers(): Promise<void> {
    const id = this.serverId();
    if (id) this._members.set(await this.api.get<Member[]>(`/servers/${id}/members`));
  }

  /** Local patch used by realtime events (e.g. channel last sequence advanced). */
  patchChannel(id: string, patch: Partial<Channel>): void {
    this._server.update((s) => (s ? { ...s, channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : s));
  }

  patchMember(userId: string, patch: Partial<Member>): void {
    this._members.update((list) => list.map((m) => (m.userId === userId ? { ...m, ...patch } : m)));
  }

  async createChannel(type: 'text' | 'voice', name: string, topic?: string): Promise<Channel> {
    const id = this.serverId();
    if (!id) throw new Error('No server selected');
    const ch = await this.api.post<Channel>(`/servers/${id}/channels`, { type, name, topic });
    this._server.update((s) => (s ? { ...s, channels: [...s.channels, ch].sort((a, b) => a.position - b.position) } : s));
    return ch;
  }
}
