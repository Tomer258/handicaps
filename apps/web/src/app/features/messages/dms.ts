import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Channel, Member } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { ToastService } from '../../core/ui/toast.service';
import { Avatar } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Group size limit: you plus nine. */
export const MAX_GROUP = 10;

/** Direct and group messages: open, add people, rename, leave. The server pushes the new channel list to everyone in it. */
@Injectable({ providedIn: 'root' })
export class DirectMessages {
  private readonly api = inject(ApiService);
  private readonly store = inject(WorkspaceStore);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(Dialog);

  /** One person → your conversation with them; more → a new group. Navigates there. */
  async open(userIds: string[], name?: string): Promise<boolean> {
    const serverId = this.store.serverId();
    if (!serverId) return false;
    try {
      const ch = await this.api.post<Channel>(`/servers/${serverId}/dms`, { userIds, name: name || undefined });
      await this.store.reload();
      await this.router.navigate(['/s', serverId, 'c', ch.id]);
      return true;
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
      return false;
    }
  }

  async addPeople(channelId: string, userIds: string[]): Promise<boolean> {
    try {
      await this.api.post<Channel>(`/channels/${channelId}/members`, { userIds });
      await this.store.reload();
      return true;
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
      return false;
    }
  }

  async rename(channelId: string, name: string): Promise<void> {
    try {
      await this.api.patch<Channel>(`/channels/${channelId}/group`, { name });
      await this.store.reload();
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
    }
  }

  async leave(channel: Channel): Promise<void> {
    try {
      await this.api.delete(`/channels/${channel.id}/members/me`);
      await this.store.reload();
      const first = this.store.textChannels()[0];
      await this.router.navigate(first ? ['/s', channel.serverId, 'c', first.id] : ['/s', channel.serverId]);
      this.toast.show(`You left ${channel.name}`);
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
    }
  }

  /** The picker: start a conversation, or add people to a group (`channel`). */
  pick(channel?: Channel): void {
    this.dialog.open(NewDmDialog, { data: { channel }, ariaLabel: channel ? 'Add people' : 'New message' });
  }
}

@Component({
  selector: 'hx-new-dm-dialog',
  imports: [Avatar, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="pop fade" (submit)="$event.preventDefault(); submit()" (keydown.escape)="ref.close()"
          style="width: 440px; max-width: calc(100vw - 32px); padding: 22px; display: flex; flex-direction: column; gap: 12px">
      <h2 class="disp" style="margin: 0; font-size: 20px">{{ adding ? 'Add people' : 'New message' }}</h2>
      <p style="margin: 0; color: var(--tx2); font-size: 13px">
        {{ adding ? 'They will see the whole conversation.' : 'Pick one friend for a direct message, or several for a group (up to ' + (max - 1) + ').' }}
      </p>
      <input class="inp" placeholder="Search friends" aria-label="Search friends" autocomplete="off" cdkFocusInitial
             [value]="query()" (input)="query.set($any($event.target).value)" />
      <div class="scroll" role="group" aria-label="Friends" style="max-height: 300px; display: flex; flex-direction: column; gap: 2px; margin: 0 -6px">
        @for (m of candidates(); track m.userId) {
          <label class="menu-i" style="cursor: pointer">
            <hx-avatar [name]="m.displayName" [hue]="m.avatarHue" [assetId]="m.avatarAssetId" [size]="28" />
            <span style="flex: 1; min-width: 0"><b dir="auto">{{ m.displayName }}</b> <span style="color: var(--tx3); font-size: 12px">&#64;{{ m.login }}</span></span>
            <input type="checkbox" [checked]="picked().has(m.userId)" (change)="toggle(m.userId)" [disabled]="!picked().has(m.userId) && full()"
                   [attr.aria-label]="m.displayName + ' @' + m.login" />
          </label>
        } @empty {
          <div style="padding: 12px; color: var(--tx3); font-size: 13px">{{ query() ? 'Nobody matches that.' : 'Nobody else to add yet — invite friends first.' }}</div>
        }
      </div>
      @if (!adding && picked().size > 1) {
        <div class="field"><label for="dm-name">Group name (optional)</label>
          <input id="dm-name" class="inp" maxlength="48" dir="auto" [value]="name()" (input)="name.set($any($event.target).value)" />
        </div>
      }
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <button type="button" class="btn ghost" (click)="ref.close()">Cancel</button>
        <button type="submit" class="btn pri" [disabled]="picked().size === 0 || busy()">
          <hx-icon [name]="adding || picked().size > 1 ? 'users' : 'message'" size="sm" />{{ action() }}
        </button>
      </div>
    </form>
  `,
})
export class NewDmDialog {
  readonly ref = inject(DialogRef);
  private readonly data = inject<{ channel?: Channel }>(DIALOG_DATA);
  private readonly store = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly dms = inject(DirectMessages);
  readonly adding = !!this.data.channel;
  readonly max = MAX_GROUP;
  readonly query = signal('');
  readonly name = signal('');
  readonly picked = signal<Set<string>>(new Set());
  readonly busy = signal(false);

  private readonly already = new Set(this.data.channel?.participants ?? []);
  readonly candidates = computed<Member[]>(() => {
    const me = this.session.userId();
    const q = this.query().trim().toLowerCase();
    return this.store.members()
      .filter((m) => m.userId !== me && !this.already.has(m.userId))
      .filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.login.toLowerCase().includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  });
  /** You (and anyone already in the group) count towards the limit. */
  readonly full = computed(() => this.picked().size + Math.max(1, this.already.size) >= MAX_GROUP);
  readonly action = computed(() => {
    if (this.adding) return 'Add';
    return this.picked().size > 1 ? 'Create group' : 'Message';
  });

  toggle(id: string): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async submit(): Promise<void> {
    const ids = [...this.picked()];
    if (ids.length === 0) return;
    this.busy.set(true);
    const ok = this.data.channel ? await this.dms.addPeople(this.data.channel.id, ids) : await this.dms.open(ids, this.name().trim());
    this.busy.set(false);
    if (ok) this.ref.close();
  }
}
