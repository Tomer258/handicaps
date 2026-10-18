import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { CreatedInvitation, Invitation } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { openUserSettings } from '../settings/settings.dialog';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { INVITE_LIFETIMES, INVITE_USES, InviteSettings } from './invite-options';

const DEFAULTS: InviteSettings = { lifetimeHours: 168, maxUses: 5, note: '' };

/**
 * The link the quick Invite dialog last made, per server. The secret is shown only once by the server, so it is kept in
 * memory (never stored) and reused while the invitation is still active.
 */
@Injectable({ providedIn: 'root' })
export class InviteLinks {
  private readonly api = inject(ApiService);
  private readonly last = new Map<string, { created: CreatedInvitation; settings: InviteSettings }>();

  constructor() {
    inject(SessionService).onTeardown(() => this.last.clear());
  }

  /** The remembered link if it still works, else a new one with the remembered (or default) settings. */
  async current(serverId: string): Promise<{ created: CreatedInvitation; settings: InviteSettings }> {
    const kept = this.last.get(serverId);
    if (kept && Date.parse(kept.created.invitation.expiresAt) > Date.now() + 5 * 60_000) {
      const active = await this.api.get<Invitation[]>(`/servers/${serverId}/invitations`);
      const row = active.find((i) => i.id === kept.created.invitation.id && i.state === 'active');
      if (row) return { created: { ...kept.created, invitation: row }, settings: kept.settings };
    }
    return this.create(serverId, kept?.settings ?? DEFAULTS);
  }

  async create(serverId: string, settings: InviteSettings): Promise<{ created: CreatedInvitation; settings: InviteSettings }> {
    const created = await this.api.post<CreatedInvitation>(`/servers/${serverId}/invitations`, {
      lifetimeHours: settings.lifetimeHours, maxUses: settings.maxUses, note: settings.note.trim() || null,
    });
    const entry = { created, settings };
    this.last.set(serverId, entry);
    return entry;
  }
}

export function openInviteDialog(dialog: Dialog): void {
  dialog.open(InviteDialog, { ariaLabel: 'Invite friends', autoFocus: 'first-tabbable' });
}

/** Quick "Invite people": makes (or reuses) a link at once, copy / share, adjustable settings. */
@Component({
  selector: 'hx-invite-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pop fade" style="width: 460px; max-width: calc(100vw - 32px); padding: 22px; display: flex; flex-direction: column; gap: 14px">
      <div style="display: flex; align-items: flex-start; gap: 12px">
        <div style="flex: 1">
          <h2 class="disp" style="margin: 0; font-size: 20px">Invite friends to {{ store.server()?.name }}</h2>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--tx2)">Each friend picks their own login with this link.</p>
        </div>
        <button class="ibtn" aria-label="Close" (click)="ref.close()"><hx-icon name="x" size="sm" /></button>
      </div>

      <div class="field">
        <label for="invite-link">Invite link</label>
        <div style="display: flex; gap: 8px">
          <input id="invite-link" class="inp mono" readonly style="flex: 1; font-size: 12.5px" data-testid="invite-link"
                 [value]="link()?.created?.url ?? (busy() ? 'Making a link…' : '')" (focus)="$any($event.target).select()" />
          <button class="btn pri" (click)="copy()" [disabled]="!link()" style="min-width: 92px">
            <hx-icon [name]="copied() ? 'check' : 'copy'" size="sm" />{{ copied() ? 'Copied' : 'Copy' }}
          </button>
        </div>
        @if (link(); as l) {
          <span style="font-size: 12px; color: var(--tx3)" data-testid="invite-summary">{{ summary() }}</span>
        }
      </div>

      @if (error(); as e) {
        <div class="note e" role="alert"><hx-icon name="alert-circle" size="sm" /> {{ e }}</div>
      }

      <button class="grp" style="padding: 0; margin: 0" [attr.aria-expanded]="editing()" (click)="editing.set(!editing())">
        <span [style.transform]="editing() ? 'none' : 'rotate(-90deg)'" style="display: inline-flex; width: 12px; height: 12px"><hx-icon name="chevron-down" size="sm" /></span>
        Link settings
      </button>
      @if (editing()) {
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; align-items: end">
          <div class="field"><label for="qi-life">Expires after</label>
            <select id="qi-life" class="inp" (change)="patch({ lifetimeHours: +$any($event.target).value })">
              @for (o of lifetimes; track o.hours) { <option [value]="o.hours" [selected]="o.hours === draft().lifetimeHours">{{ o.label }}</option> }
            </select></div>
          <div class="field"><label for="qi-uses">Max uses</label>
            <select id="qi-uses" class="inp" (change)="patch({ maxUses: +$any($event.target).value })">
              @for (u of uses; track u) { <option [value]="u" [selected]="u === draft().maxUses">{{ u === 1 ? '1 person' : u + ' people' }}</option> }
            </select></div>
          <div class="field" style="grid-column: 1 / -1"><label for="qi-note">Note (only admins see it)</label>
            <input id="qi-note" class="inp" maxlength="100" placeholder="For Gal" [value]="draft().note" (input)="patch({ note: $any($event.target).value })" /></div>
        </div>
        <button class="btn sec" (click)="regenerate()" [disabled]="busy()">Make a new link with these settings</button>
      }

      <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px">
        <button class="btn ghost" style="padding-left: 0" (click)="manage()">Manage invites</button>
        <span style="flex: 1"></span>
        @if (canShare) {
          <button class="btn sec" (click)="share()" [disabled]="!link()"><hx-icon name="link" size="sm" />Share…</button>
        }
        <button class="btn sec" (click)="ref.close()">Done</button>
      </div>
    </div>
  `,
})
export class InviteDialog {
  readonly ref = inject(DialogRef);
  readonly store = inject(WorkspaceStore);
  private readonly links = inject(InviteLinks);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(Dialog);

  readonly lifetimes = INVITE_LIFETIMES;
  readonly uses = INVITE_USES;
  readonly canShare = typeof navigator.share === 'function';
  readonly link = signal<{ created: CreatedInvitation; settings: InviteSettings } | null>(null);
  readonly draft = signal<InviteSettings>(DEFAULTS);
  readonly busy = signal(false);
  readonly copied = signal(false);
  readonly editing = signal(false);
  readonly error = signal<string | null>(null);

  readonly summary = computed(() => {
    const l = this.link();
    if (!l) return '';
    const i = l.created.invitation;
    const left = i.maxUses - i.usedCount;
    const when = new Date(i.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return `Works for ${left === 1 ? '1 more person' : left + ' more people'} · expires ${when}`;
  });

  constructor() {
    void this.load(() => this.links.current(this.store.serverId()!));
  }

  patch(p: Partial<InviteSettings>): void {
    this.draft.update((d) => ({ ...d, ...p }));
  }

  async regenerate(): Promise<void> {
    await this.load(() => this.links.create(this.store.serverId()!, this.draft()));
    if (!this.error()) {
      this.editing.set(false);
      this.toast.show('New invite link ready', 'info');
    }
  }

  async copy(): Promise<void> {
    const url = this.link()?.created.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.toast.show('Copy failed — select the link and copy it manually.', 'warn');
    }
  }

  async share(): Promise<void> {
    const url = this.link()?.created.url;
    if (!url) return;
    try {
      await navigator.share({ title: `Join ${this.store.server()?.name ?? 'Hangar'}`, url });
    } catch {
      /* dismissed */
    }
  }

  manage(): void {
    this.ref.close();
    openUserSettings(this.dialog, 'invites');
  }

  private async load(make: () => Promise<{ created: CreatedInvitation; settings: InviteSettings }>): Promise<void> {
    if (!this.store.serverId()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const l = await make();
      this.link.set(l);
      this.draft.set(l.settings);
      this.copied.set(false);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
