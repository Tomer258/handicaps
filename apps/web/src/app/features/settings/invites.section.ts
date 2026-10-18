import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { CreatedInvitation, Invitation } from '../../core/api/models';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Server administration: invitations (the secret is shown once). */
@Component({
  selector: 'hx-invites-section',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Invites</h2>

    <div class="lbl" style="margin: 0 0 8px">Create an invite</div>
    <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; align-items: end">
      <div class="field"><label for="inv-life">Expires after</label>
        <select id="inv-life" class="inp" [value]="lifetime()" (change)="lifetime.set(+$any($event.target).value)">
          <option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option><option value="720">30 days</option>
        </select></div>
      <div class="field"><label for="inv-uses">Max uses</label>
        <select id="inv-uses" class="inp" [value]="maxUses()" (change)="maxUses.set(+$any($event.target).value)">
          <option value="1">1 person</option><option value="5">5 people</option><option value="10">10 people</option><option value="25">25 people</option>
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
    @for (i of invites(); track i.id) {
      <div class="srow">
        <div><div class="t">{{ i.note || 'Invite' }}</div>
          <div class="d">{{ i.usedCount }}/{{ i.maxUses }} used · expires {{ date(i.expiresAt) }}</div></div>
        <button class="btn ghost" style="color: var(--danger)" (click)="revokeInvite(i)" [attr.aria-label]="'Revoke invite ' + (i.note || '')">Revoke</button>
      </div>
    } @empty {
      <div style="font-size: 12.5px; color: var(--tx3); padding: 8px 0">No active invites.</div>
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
      this.invites.update((l) => l.filter((x) => x.id !== i.id));
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
