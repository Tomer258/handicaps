import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Perm, has } from '../../core/api/models';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { PERM_GROUPS } from '../settings/perm-groups';
import { WorkspaceStore } from '../workspaces/workspace.store';

interface Override {
  id?: string;
  roleId: string | null;
  memberUserId: string | null;
  allow: number;
  deny: number;
}

type Tri = 'allow' | 'inherit' | 'deny';

// Mirrors Hangar.Core.Permissions.PermissionSets: bits that do nothing on the other channel type are hidden.
const TEXT_ONLY = Perm.SendMessages | Perm.AttachFiles | Perm.AddReactions | Perm.MentionEveryone | Perm.ManageMessages;
const VOICE_ONLY = Perm.JoinVoice | Perm.Speak | Perm.PublishCamera | Perm.ShareScreen | Perm.PlaySoundboard | Perm.MuteMembers |
  Perm.RemoveFromVoice | Perm.StopOthersSounds;

/** Channel settings: name/topic/delete (Manage channels) and per-role / per-member permission overrides (Manage roles). */
@Component({
  selector: 'hx-channel-settings-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pop fade" style="width: 720px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 48px); display: flex; flex-direction: column">
      <div style="display: flex; align-items: center; gap: 10px; padding: 18px 22px 0">
        <hx-icon [name]="channel()?.type === 'voice' ? 'volume' : 'hash'" />
        <h2 class="disp" style="margin: 0; font-size: 20px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" dir="auto">{{ channel()?.name }}</h2>
        <button class="ibtn" aria-label="Close" (click)="ref.close()"><svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
      </div>
      <div role="tablist" aria-label="Channel settings" style="display: flex; gap: 4px; padding: 12px 22px 0; border-bottom: 1px solid var(--line)">
        @if (canEdit()) {
          <button role="tab" class="tabb" [attr.aria-selected]="tab() === 'overview'" (click)="tab.set('overview')">Overview</button>
        }
        @if (canPerms()) {
          <button role="tab" class="tabb" [attr.aria-selected]="tab() === 'perms'" (click)="openPerms()">Permissions</button>
        }
      </div>

      <div class="scroll" style="padding: 18px 22px 22px; flex: 1; min-height: 0">
        @if (tab() === 'overview') {
          <div class="field"><label for="cs-name">Name</label>
            <input id="cs-name" class="inp" maxlength="48" dir="auto" [value]="name()" (input)="name.set($any($event.target).value)" /></div>
          @if (channel()?.type === 'text') {
            <div class="field" style="margin-top: 12px"><label for="cs-topic">Topic</label>
              <input id="cs-topic" class="inp" maxlength="240" dir="auto" [value]="topic()" (input)="topic.set($any($event.target).value)" /></div>
          }
          <div style="display: flex; gap: 8px; margin-top: 16px; align-items: center">
            <button class="btn ghost" style="color: var(--danger)" (click)="archive()" [disabled]="busy()"><hx-icon name="trash" size="sm" />Delete channel</button>
            <span style="flex: 1"></span>
            <button class="btn pri" (click)="save()" [disabled]="busy() || !name().trim()">Save changes</button>
          </div>
        } @else {
          <div class="perm-grid">
            <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
              <div class="lbl" style="margin: 0 0 4px">Roles &amp; members</div>
              @for (s of subjects(); track s.key) {
                <button class="snav" [attr.aria-pressed]="selected() === s.key" (click)="selected.set(s.key)"
                        [style.background]="selected() === s.key ? 'var(--bg3)' : null" [style.color]="selected() === s.key ? 'var(--tx)' : null">
                  <span style="width: 8px; height: 8px; border-radius: 50%; flex: none" [style.background]="s.color"></span>
                  <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" dir="auto">{{ s.label }}</span>
                  @if (!s.manageable) { <hx-icon name="lock" size="sm" /> }
                </button>
              }
              @if (addable().length) {
                <select class="inp" style="margin-top: 8px" aria-label="Add a role or member" (change)="add($any($event.target).value); $any($event.target).value = ''">
                  <option value="">+ Add role or member…</option>
                  @for (a of addable(); track a.key) { <option [value]="a.key">{{ a.label }}</option> }
                </select>
              }
            </div>
            <div style="min-width: 0">
              @if (current(); as cur) {
                <p style="margin: 0 0 10px; font-size: 12.5px; color: var(--tx3)">
                  ✓ allows and ✕ denies in this channel only. / keeps the server setting. A member's own entry beats their roles.
                  @if (!cur.manageable) { <br /><b>You can only look at this one</b> — it is not below your highest role. }
                </p>
                @for (g of groups(); track g.label) {
                  <div class="lbl" style="margin: 12px 0 4px">{{ g.label }}</div>
                  @for (p of g.perms; track p.bit) {
                    <div class="prow">
                      <span style="flex: 1; font-size: 13px">{{ p.label }}</span>
                      <div class="tri" role="radiogroup" [attr.aria-label]="p.label">
                        <button role="radio" class="d" [attr.aria-checked]="state(cur.o, p.bit) === 'deny'" aria-label="Deny" title="Deny"
                                [disabled]="!cur.manageable" (click)="set(cur.o, p.bit, 'deny')">✕</button>
                        <button role="radio" class="n" [attr.aria-checked]="state(cur.o, p.bit) === 'inherit'" aria-label="Default" title="Use the server setting"
                                [disabled]="!cur.manageable" (click)="set(cur.o, p.bit, 'inherit')">/</button>
                        <button role="radio" class="a" [attr.aria-checked]="state(cur.o, p.bit) === 'allow'" aria-label="Allow"
                                [title]="store.canGrant(p.bit) ? 'Allow' : 'You cannot allow a permission you do not have'"
                                [disabled]="!cur.manageable || (!store.canGrant(p.bit) && state(cur.o, p.bit) !== 'allow')" (click)="set(cur.o, p.bit, 'allow')">✓</button>
                      </div>
                    </div>
                  }
                }
              }
            </div>
          </div>
        }
        @if (error(); as e) { <div class="note e" role="alert" style="margin-top: 12px">{{ e }}</div> }
      </div>
    </div>
  `,
  styles: `
    .tabb { padding: 8px 12px; font-size: 13px; font-weight: 600; color: var(--tx3); border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tabb[aria-selected='true'] { color: var(--tx); border-color: var(--accent); }
    .perm-grid { display: grid; grid-template-columns: 200px 1fr; gap: 20px; }
    @media (max-width: 600px) { .perm-grid { grid-template-columns: 1fr; } }
    .prow { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
    .tri { display: inline-flex; border: 1px solid var(--line2); border-radius: 8px; overflow: hidden; }
    .tri button { width: 30px; height: 26px; font-size: 13px; color: var(--tx3); }
    .tri button + button { border-left: 1px solid var(--line2); }
    .tri button:disabled { cursor: default; opacity: .45; }
    .tri .d[aria-checked='true'] { background: var(--danger); color: #fff; opacity: 1; }
    .tri .n[aria-checked='true'] { background: var(--bg3); color: var(--tx); opacity: 1; }
    .tri .a[aria-checked='true'] { background: var(--ok, #46a758); color: #fff; opacity: 1; }
  `,
})
export class ChannelSettingsDialog {
  readonly data = inject<{ channelId: string }>(DIALOG_DATA);
  readonly ref = inject(DialogRef);
  readonly store = inject(WorkspaceStore);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly channel = computed(() => this.store.channels().find((c) => c.id === this.data.channelId) ?? null);
  readonly canEdit = computed(() => has(this.store.myPermissions(), Perm.ManageChannels));
  readonly canPerms = computed(() => has(this.store.myPermissions(), Perm.ManageRoles));
  readonly tab = signal<'overview' | 'perms'>(this.canEdit() ? 'overview' : 'perms');
  readonly name = signal(this.channel()?.name ?? '');
  readonly topic = signal(this.channel()?.topic ?? '');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly overrides = signal<Override[]>([]);
  /** Subjects added in the UI that have no stored override yet. */
  private readonly extra = signal<string[]>([]);
  readonly selected = signal<string | null>(null);

  readonly groups = computed(() => {
    const hide = this.channel()?.type === 'voice' ? TEXT_ONLY : VOICE_ONLY;
    return PERM_GROUPS.filter((g) => g.label !== 'Server')
      .map((g) => ({ ...g, perms: g.perms.filter((p) => !has(hide, p.bit) && p.bit !== Perm.UploadSoundboard && p.bit !== Perm.ManageOwnSounds && p.bit !== Perm.ManageAnySounds) }))
      .filter((g) => g.perms.length);
  });

  readonly subjects = computed(() => {
    const roles = this.store.server()?.roles ?? [];
    const everyone = roles.find((r) => r.isDefault);
    const keys = new Set<string>(everyone ? [`r:${everyone.id}`] : []);
    for (const o of this.overrides()) keys.add(o.roleId ? `r:${o.roleId}` : `m:${o.memberUserId}`);
    for (const k of this.extra()) keys.add(k);
    return [...keys].map((k) => this.describe(k)).filter((s) => !!s)
      .sort((a, b) => Number(b.isRole) - Number(a.isRole) || b.position - a.position || a.label.localeCompare(b.label));
  });

  readonly addable = computed(() => {
    const taken = new Set(this.subjects().map((s) => s.key));
    const roles = (this.store.server()?.roles ?? []).filter((r) => !r.isDefault && this.store.canManageRole(r))
      .sort((a, b) => b.position - a.position).map((r) => ({ key: `r:${r.id}`, label: `Role: ${r.name}` }));
    const members = [...this.store.memberById().values()].filter((m) => this.store.canManageMember(m))
      .map((m) => ({ key: `m:${m.userId}`, label: `Member: ${m.displayName}` }));
    return [...roles, ...members].filter((a) => !taken.has(a.key));
  });

  readonly current = computed(() => {
    const key = this.selected() ?? this.subjects()[0]?.key;
    if (!key) return null;
    const s = this.subjects().find((x) => x.key === key);
    if (!s) return null;
    const id = key.slice(2);
    const o = this.overrides().find((x) => (s.isRole ? x.roleId === id : x.memberUserId === id)) ??
      { roleId: s.isRole ? id : null, memberUserId: s.isRole ? null : id, allow: 0, deny: 0 };
    return { ...s, o };
  });

  constructor() {
    if (this.tab() === 'perms') void this.loadOverrides();
  }

  openPerms(): void {
    this.tab.set('perms');
    void this.loadOverrides();
  }

  state(o: Override, bit: number): Tri {
    return has(o.allow, bit) ? 'allow' : has(o.deny, bit) ? 'deny' : 'inherit';
  }

  async set(o: Override, bit: number, to: Tri): Promise<void> {
    const allow = to === 'allow' ? o.allow | bit : o.allow & ~bit;
    const deny = to === 'deny' ? o.deny | bit : o.deny & ~bit;
    this.error.set(null);
    try {
      await this.api.put(`/channels/${this.data.channelId}/overrides`, { roleId: o.roleId, memberUserId: o.memberUserId, allow, deny });
      await this.loadOverrides();
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    }
  }

  add(key: string): void {
    if (!key) return;
    this.extra.update((l) => [...l, key]);
    this.selected.set(key);
  }

  async save(): Promise<void> {
    const c = this.channel();
    if (!c) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.patch(`/channels/${c.id}`, { name: this.name().trim(), topic: c.type === 'text' ? this.topic().trim() : undefined });
      await this.store.reload();
      this.toast.show('Channel updated', 'info');
      this.ref.close();
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  async archive(): Promise<void> {
    const c = this.channel();
    if (!c || !confirm(`Delete ${c.type === 'text' ? '#' : ''}${c.name}? Its messages will no longer be visible.`)) return;
    this.busy.set(true);
    try {
      await this.api.delete(`/channels/${c.id}`);
      this.ref.close();
      if (this.router.url.includes(c.id)) await this.router.navigate(['/s', c.serverId]);
      await this.store.reload();
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  private describe(key: string): { key: string; label: string; color: string; isRole: boolean; position: number; manageable: boolean } | null {
    const id = key.slice(2);
    if (key.startsWith('r:')) {
      const r = (this.store.server()?.roles ?? []).find((x) => x.id === id);
      if (!r) return null;
      return { key, label: r.isDefault ? '@everyone' : r.name, color: r.color || 'var(--tx3)', isRole: true, position: r.position, manageable: this.store.canManageRole(r) };
    }
    const m = this.store.memberById().get(id);
    if (!m) return null;
    return { key, label: m.displayName, color: 'var(--accent)', isRole: false, position: 0, manageable: this.store.canManageMember(m) };
  }

  private async loadOverrides(): Promise<void> {
    try {
      this.overrides.set(await this.api.get<Override[]>(`/channels/${this.data.channelId}/overrides`));
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    }
  }
}

/** True when the caller may change anything in channel settings. */
export function canOpenChannelSettings(store: WorkspaceStore): boolean {
  return has(store.myPermissions(), Perm.ManageChannels) || has(store.myPermissions(), Perm.ManageRoles);
}

export function openChannelSettings(dialog: Dialog, channelId: string): void {
  dialog.open(ChannelSettingsDialog, { data: { channelId }, ariaLabel: 'Channel settings' });
}
