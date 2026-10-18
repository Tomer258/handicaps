import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { CreatedInvitation, Invitation } from '../../core/api/models';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { INVITE_LIFETIMES, INVITE_USES } from '../invites/invite-options';

/** Server administration: invitations (the secret is shown once), who made them and who joined with them. */
@Component({
  selector: 'hx-invites-section',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Invites</h2>

    <div class="lbl" style="margin: 0 0 8px">Create an invite</div>
    <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; align-items: end">
      <div class="field"><label for="inv-life">Expires after</label>
        <select id="inv-life" class="inp" (change)="lifetime.set(+$any($event.target).value)">
          @for (o of lifetimes; track o.hours) { <option [value]="o.hours" [selected]="o.hours === lifetime()">{{ o.label }}</option> }
        </select></div>
      <div class="field"><label for="inv-uses">Max uses</label>
        <select id="inv-uses" class="inp" (change)="maxUses.set(+$any($event.target).value)">
          @for (u of uses; track u) { <option [value]="u" [selected]="u === maxUses()">{{ u === 1 ? '1 person' : u + ' people' }}</option> }
        </select></div>
      <div class="field"><label for="inv-note">Note (optional)</label>
        <input id="inv-note" class="inp" maxlength="100" placeholder="For Gal" [value]="note()" (input)="note.set($any($event.target).value)" /></div>
      <button class="btn pri" (click)="createInvite()" [disabled]="busy()">Create invite link</button>
    </div>
    @if (created(); as c) {
      <div class="note" role="status" style="margin-top: 10px; align-items: center; flex-wrap: wrap; border-color: var(--accent)">
        <div style="flex: 1; min-width: 220px"><b style="color: var(--tx)">Invite link — copy it now, it is shown only once.</b>
          <div class="mono" style="font-size: 12px; word-break: break-all; margin-top: 4px" data-testid="invite-url">{{ c.url }}</div></div>
        <button class="btn sec" (click)="copy(c.url)"><hx-icon name="copy" size="sm" />Copy</button>
      </div>
    }
    <div class="lbl" style="margin: 22px 0 4px">Active invites</div>
    @for (i of active(); track i.id) {
      <div class="srow" data-testid="invite-row">
        <div style="min-width: 0"><div class="t">{{ i.note || 'Invite' }}</div>
          <div class="d">{{ i.usedCount }}/{{ i.maxUses }} used · expires {{ date(i.expiresAt) }}{{ i.createdByName ? ' · by ' + i.createdByName : '' }}</div>
          @if (i.joined.length) { <div class="d" style="color: var(--tx2)">Joined: {{ names(i) }}</div> }
        </div>
        <button class="btn ghost" style="color: var(--danger)" (click)="revokeInvite(i)" [attr.aria-label]="'Revoke invite ' + (i.note || '')">Revoke</button>
      </div>
    } @empty {
      <div style="font-size: 12.5px; color: var(--tx3); padding: 8px 0">No active invites.</div>
    }
    @if (ended().length) {
      <div class="lbl" style="margin: 22px 0 4px">Recently ended</div>
      @for (i of ended(); track i.id) {
        <div class="srow" data-testid="ended-invite-row">
          <div style="min-width: 0"><div class="t" style="color: var(--tx2)">{{ i.note || 'Invite' }}</div>
            <div class="d">{{ stateLabel[i.state] }} · {{ i.usedCount }}/{{ i.maxUses }} used{{ i.createdByName ? ' · by ' + i.createdByName : '' }}</div>
            @if (i.joined.length) { <div class="d" style="color: var(--tx2)">Joined: {{ names(i) }}</div> }
          </div>
        </div>
      }
    }
  `,
})
export class InvitesSection {
  private readonly api = inject(ApiService);
  private readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);

  readonly lifetime = signal(168);
  readonly maxUses = signal(1);
  readonly note = signal('');
  readonly busy = signal(false);
  readonly created = signal<CreatedInvitation | null>(null);
  readonly invites = signal<Invitation[]>([]);
  readonly active = computed(() => this.invites().filter((i) => i.state === 'active'));
  readonly ended = computed(() => this.invites().filter((i) => i.state !== 'active'));
  readonly lifetimes = INVITE_LIFETIMES;
  readonly uses = INVITE_USES;
  readonly stateLabel = { active: 'Active', usedUp: 'Used up', expired: 'Expired', revoked: 'Revoked' } as const;

  names(i: Invitation): string {
    return i.joined.map((j) => j.displayName).join(', ');
  }

  constructor() {
    void this.loadInvites();
  }

  date(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async createInvite(): Promise<void> {
    const serverId = this.store.serverId();
    if (!serverId) return;
    this.busy.set(true);
    try {
      const c = await this.api.post<CreatedInvitation>(`/servers/${serverId}/invitations`, {
        lifetimeHours: this.lifetime(), maxUses: this.maxUses(), note: this.note().trim() || null,
      });
      this.created.set(c);
      this.note.set('');
      await this.loadInvites();
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show('Invite link copied', 'info');
    } catch {
      this.toast.show('Copy failed — select the link and copy it manually.', 'warn');
    }
  }

  async revokeInvite(i: Invitation): Promise<void> {
    try {
      await this.api.delete(`/servers/${this.store.serverId()}/invitations/${i.id}`);
      this.invites.update((l) => l.map((x) => (x.id === i.id ? { ...x, state: 'revoked' as const } : x)));
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  private async loadInvites(): Promise<void> {
    try {
      this.invites.set(await this.api.get<Invitation[]>(`/servers/${this.store.serverId()}/invitations`));
    } catch {
      /* shown empty */
    }
  }
}
