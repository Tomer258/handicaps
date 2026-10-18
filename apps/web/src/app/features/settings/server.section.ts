import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { CreatedInvitation, Invitation, Member, Perm, Role, has } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { ToastService } from '../../core/ui/toast.service';
import { avatarColor, initials } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

const PERM_GROUPS: { label: string; perms: { bit: number; label: string }[] }[] = [
  { label: 'Text', perms: [
    { bit: Perm.ViewChannel, label: 'View channels' }, { bit: Perm.SendMessages, label: 'Send messages' }, { bit: Perm.AttachFiles, label: 'Attach files' },
    { bit: Perm.AddReactions, label: 'Add reactions' }, { bit: Perm.MentionEveryone, label: 'Mention @everyone' }, { bit: Perm.ManageMessages, label: 'Manage messages' },
  ] },
  { label: 'Voice & video', perms: [
    { bit: Perm.JoinVoice, label: 'Join voice' }, { bit: Perm.Speak, label: 'Speak' }, { bit: Perm.PublishCamera, label: 'Camera' }, { bit: Perm.ShareScreen, label: 'Share screen' },
    { bit: Perm.MuteMembers, label: 'Mute members' }, { bit: Perm.RemoveFromVoice, label: 'Remove from voice' },
  ] },
  { label: 'Soundboard', perms: [
    { bit: Perm.PlaySoundboard, label: 'Play sounds' }, { bit: Perm.UploadSoundboard, label: 'Upload sounds' }, { bit: Perm.ManageOwnSounds, label: 'Manage own sounds' },
    { bit: Perm.ManageAnySounds, label: 'Manage any sound' }, { bit: Perm.StopOthersSounds, label: "Stop others' sounds" },
  ] },
  { label: 'Server', perms: [
    { bit: Perm.ManageChannels, label: 'Manage channels' }, { bit: Perm.ManageRoles, label: 'Manage roles' }, { bit: Perm.ManageInvites, label: 'Manage invites' },
    { bit: Perm.ViewAudit, label: 'View audit log' }, { bit: Perm.Administrator, label: 'Administrator (everything)' },
  ] },
];

/** Server administration: invitations (secret shown once), member roles / removal, and role permissions. */
@Component({
  selector: 'hx-server-section',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Invites &amp; members</h2>

    @if (canInvite()) {
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
    }

    @if (canRoles()) {
      <div class="lbl" style="margin: 28px 0 4px">Members</div>
      @for (m of members(); track m.userId) {
        <div class="srow" style="align-items: center">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0">
            <span class="av s32" [style.background]="color(m.avatarHue)">{{ ini(m.displayName) }}</span>
            <div style="min-width: 0"><div class="t" dir="auto">{{ m.displayName }}{{ m.userId === me() ? ' (you)' : '' }}</div>
              <div class="d mono">&#64;{{ m.login }}{{ m.isOwner ? ' · owner' : '' }}</div></div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end">
            @for (r of assignable(); track r.id) {
              <button class="cat" [attr.aria-pressed]="m.roleIds.includes(r.id)" (click)="toggleRole(m, r)" [disabled]="m.isOwner"
                      [attr.aria-label]="r.name + ' role for ' + m.displayName">{{ r.name }}</button>
            }
            @if (canRemove() && !m.isOwner && m.userId !== me()) {
              <button class="ibtn" style="width: 28px; height: 28px; color: var(--danger)" [attr.aria-label]="'Remove ' + m.displayName + ' from the server'"
                      title="Remove from server" (click)="remove(m)"><hx-icon name="trash" size="sm" /></button>
            }
          </div>
        </div>
      }

      <div class="lbl" style="margin: 28px 0 4px">Roles</div>
      @for (r of roles(); track r.id) {
        <div class="card" style="margin-top: 8px; padding: 0">
          <button style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 16px; text-align: left" (click)="openRole.set(openRole() === r.id ? null : r.id)"
                  [attr.aria-expanded]="openRole() === r.id">
            <span style="width: 10px; height: 10px; border-radius: 50%" [style.background]="r.color || 'var(--tx3)'"></span>
            <b style="flex: 1">{{ r.isDefault ? '@everyone' : r.name }}</b>
            <span style="font-size: 12px; color: var(--tx3)">{{ count(r.permissions) }} permissions</span>
            <hx-icon [name]="openRole() === r.id ? 'chevron-down' : 'chevron-right'" size="sm" />
          </button>
          @if (openRole() === r.id) {
            <div style="padding: 0 16px 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px 18px">
              @for (g of groups; track g.label) {
                <div><div class="lbl" style="margin: 10px 0 4px">{{ g.label }}</div>
                  @for (p of g.perms; track p.bit) {
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer">
                      <input type="checkbox" [checked]="hasBit(r.permissions, p.bit)" (change)="toggleBit(r, p.bit)" />{{ p.label }}
                    </label>
                  }
                </div>
              }
            </div>
          }
        </div>
      }
    }
  `,
})
export class ServerSection {
  private readonly api = inject(ApiService);
  private readonly store = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);

  readonly groups = PERM_GROUPS;
  readonly lifetime = signal(168);
  readonly maxUses = signal(1);
  readonly note = signal('');
  readonly busy = signal(false);
  readonly created = signal<CreatedInvitation | null>(null);
  readonly invites = signal<Invitation[]>([]);
  readonly openRole = signal<string | null>(null);

  readonly me = this.session.userId;
  private readonly perms = computed(() => this.store.server()?.myPermissions ?? 0);
  readonly canInvite = computed(() => has(this.perms(), Perm.ManageInvites) || has(this.perms(), Perm.Administrator));
  readonly canRoles = computed(() => has(this.perms(), Perm.ManageRoles) || has(this.perms(), Perm.Administrator));
  readonly canRemove = computed(() => has(this.perms(), Perm.Administrator));
  readonly roles = computed(() => [...(this.store.server()?.roles ?? [])].sort((a, b) => b.position - a.position));
  readonly assignable = computed(() => this.roles().filter((r) => !r.isDefault));
  readonly members = computed(() => [...this.store.memberById().values()].sort((a, b) => a.displayName.localeCompare(b.displayName)));

  constructor() {
    if (this.canInvite()) void this.loadInvites();
  }

  color(h: number): string {
    return avatarColor(h);
  }

  ini(n: string): string {
    return initials(n);
  }

  date(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  hasBit(mask: number, bit: number): boolean {
    return has(mask, bit);
  }

  count(mask: number): number {
    return PERM_GROUPS.flatMap((g) => g.perms).filter((p) => has(mask, p.bit)).length;
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

  async toggleRole(m: Member, r: Role): Promise<void> {
    const next = m.roleIds.includes(r.id) ? m.roleIds.filter((x) => x !== r.id) : [...m.roleIds, r.id];
    try {
      await this.api.put(`/servers/${this.store.serverId()}/members/${m.userId}/roles`, { roleIds: next.filter((id) => this.assignable().some((a) => a.id === id)) });
      this.store.patchMember(m.userId, { roleIds: next });
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async remove(m: Member): Promise<void> {
    if (!confirm(`Remove ${m.displayName} from the server? They will need a new invite to come back.`)) return;
    try {
      await this.api.delete(`/servers/${this.store.serverId()}/members/${m.userId}`);
      await this.store.reload();
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async toggleBit(r: Role, bit: number): Promise<void> {
    const next = has(r.permissions, bit) ? r.permissions & ~bit : r.permissions | bit;
    try {
      await this.api.patch(`/servers/${this.store.serverId()}/roles/${r.id}`, { permissions: next });
      await this.store.reload();
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
