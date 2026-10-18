import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { WorkspaceStore } from '../workspaces/workspace.store';

interface AuditEntry {
  id: string;
  time: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  outcome: string;
  detail: string | null;
}

interface AuditPage {
  entries: AuditEntry[];
  before: string | null;
}

/** What happened, in words. `t` is the resolved target name (or a fallback). */
const PHRASES: Record<string, (t: string, e: AuditEntry) => string> = {
  'role.create': (t) => `created the role ${t}`,
  'role.update': (t) => `edited the role ${t}`,
  'role.delete': (_t, e) => `deleted the role ${e.detail ?? ''}`.trim(),
  'role.reorder': () => 'reordered roles',
  'member.roles_set': (t) => `changed the roles of ${t}`,
  'member.remove': (t) => `removed ${t} from the server`,
  'voice.server_mute': (t) => `server-muted ${t}`,
  'voice.server_unmute': (t) => `lifted the server mute of ${t}`,
  'voice.disconnect': (t) => `disconnected ${t} from voice`,
  'channel.create': (t, e) => `created the channel ${e.detail ?? t}`,
  'channel.update': (t) => `edited the channel ${t}`,
  'channel.archive': (t) => `deleted the channel ${t}`,
  'channel.override_set': (t) => `changed permissions in ${t}`,
  'invite.create': () => 'created an invite',
  'invite.revoke': () => 'revoked an invite',
  'auth.register': () => 'joined the server',
};

/** Server administration: the moderation/admin log (needs View audit log). */
@Component({
  selector: 'hx-audit-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 8px; font-size: 26px">Audit log</h2>
    <p style="margin: 0 0 16px; font-size: 13px; color: var(--tx3)">Admin and moderation actions from the last 90 days, newest first.</p>
    @for (e of entries(); track e.id) {
      <div class="srow" style="align-items: baseline">
        <div style="min-width: 0">
          <div class="t" dir="auto"><b>{{ e.actorName ?? 'Someone' }}</b> <span style="font-weight: 400; color: var(--tx2)">{{ phrase(e) }}</span></div>
          @if (e.outcome !== 'ok') { <div class="d" style="color: var(--danger)">{{ e.outcome }}</div> }
        </div>
        <span class="d mono" style="flex: none; white-space: nowrap">{{ date(e.time) }}</span>
      </div>
    } @empty {
      @if (!loading()) { <div style="font-size: 12.5px; color: var(--tx3); padding: 8px 0">Nothing recorded yet.</div> }
    }
    @if (error(); as err) { <div class="note e" role="alert" style="margin-top: 10px">{{ err }}</div> }
    @if (before()) {
      <button class="btn sec" style="margin-top: 12px" (click)="load()" [disabled]="loading()">Load older</button>
    }
  `,
})
export class AuditSection {
  private readonly api = inject(ApiService);
  private readonly store = inject(WorkspaceStore);

  readonly entries = signal<AuditEntry[]>([]);
  readonly before = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  phrase(e: AuditEntry): string {
    const name = e.targetName ?? (e.targetType === 'channel' ? 'a deleted channel' : e.targetType === 'role' ? 'a deleted role' : 'someone');
    const target = e.targetType === 'channel' && e.targetName ? `#${e.targetName}` : name;
    return PHRASES[e.action]?.(target, e) ?? e.action;
  }

  date(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const cursor = this.before();
      const q = cursor ? `?before=${encodeURIComponent(cursor)}` : '';
      const page = await this.api.get<AuditPage>(`/servers/${this.store.serverId()}/audit${q}`);
      this.entries.update((l) => [...l, ...page.entries]);
      this.before.set(page.before);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.loading.set(false);
    }
  }
}
