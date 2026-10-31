import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Icon } from '../../shared/ui/icon';
import { UserPanel } from './user-panel';
import { LayoutService } from './layout.service';
import { Channel } from '../../core/api/models';
import { ChannelBadges } from './channel-badges.service';
import { VoiceRoster } from './voice-roster';
import { VoicePanel } from './voice-panel';
import { CreateChannelDialog } from './create-channel.dialog';
import { Dialog } from '@angular/cdk/dialog';
import { openInviteDialog } from '../invites/invite.dialog';
import { Avatar } from '../../shared/ui/avatar';
import { DirectMessages } from '../messages/dms';
import { SessionService } from '../../core/auth/session.service';

/** ChannelSidebar (hx-channel-sidebar): header, text/voice groups, persistent voice panel, user panel. */
@Component({
  selector: 'hx-channel-sidebar',
  imports: [RouterLink, RouterLinkActive, Icon, Avatar, UserPanel, VoiceRoster, VoicePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'side',
    'aria-label': 'Channels',
    role: 'navigation',
    style: 'width: 252px; flex: none; display: flex; flex-direction: column; background: var(--bg1); border-radius: 14px 0 0 0; border-left: 1px solid var(--line); border-top: 1px solid var(--line); margin-top: 8px',
  },
  template: `
    <div style="height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--line)">
      <span class="disp" style="flex: 1; font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ store.server()?.name }}</span>
      <span class="mono" style="font-size: 11px; color: var(--tx3)">{{ store.members().length }} members</span>
      @if (store.canManageInvites()) {
        <button class="ibtn" aria-label="Invite friends" title="Invite friends" (click)="invite()" style="width: 28px; height: 28px; flex: none; margin-right: -6px"><hx-icon name="user-plus" size="sm" /></button>
      }
    </div>

    <div class="scroll" style="flex: 1; padding: 4px 8px 12px">
      <div style="display: flex; align-items: center">
        <button class="grp" (click)="dmOpen.set(!dmOpen())" [attr.aria-expanded]="dmOpen()">
          <span [style.transform]="dmOpen() ? 'none' : 'rotate(-90deg)'" style="display: inline-flex; width: 12px; height: 12px"><hx-icon name="chevron-down" size="sm" /></span>
          Direct messages
        </button>
        <button class="ibtn" aria-label="New message" title="New message" (click)="dms.pick()" style="width: 24px; height: 24px; margin-top: 10px; flex: none"><hx-icon name="plus" size="sm" /></button>
      </div>
      @if (dmOpen()) {
        <div style="display: flex; flex-direction: column; gap: 2px">
          @for (c of store.dmChannels(); track c.id) {
            <a class="ch" [class.unread]="badges.unread(c.id) > 0" [routerLink]="['/s', c.serverId, 'c', c.id]" routerLinkActive="on"
               ariaCurrentWhenActive="page" (click)="layout.navOpen.set(false)" [attr.aria-label]="(c.type === 'group' ? 'Group: ' : 'Direct message: ') + c.name">
              @if (c.type === 'direct' && other(c); as o) {
                <hx-avatar [name]="o.displayName" [hue]="o.avatarHue" [assetId]="o.avatarAssetId" [size]="20" />
              } @else {
                <hx-icon [name]="c.type === 'group' ? 'users' : 'message'" size="sm" />
              }
              <span class="nm" dir="auto">{{ c.name }}</span>
              @if (badges.mentions(c.id); as m) {
                <span class="cnt m" [attr.aria-label]="m + ' unread'">{{ m > 99 ? '99+' : m }}</span>
              } @else if (badges.unread(c.id); as u) {
                <span class="cnt" [attr.aria-label]="u + ' unread'">{{ u > 99 ? '99+' : u }}</span>
              }
            </a>
          } @empty {
            <button class="ch" style="border: 0; background: none; text-align: left; cursor: pointer; color: var(--tx3)" (click)="dms.pick()">
              <hx-icon name="message" size="sm" /><span class="nm">Message a friend</span>
            </button>
          }
        </div>
      }

      <div style="display: flex; align-items: center">
        <button class="grp" (click)="textOpen.set(!textOpen())" [attr.aria-expanded]="textOpen()">
          <span [style.transform]="textOpen() ? 'none' : 'rotate(-90deg)'" style="display: inline-flex; width: 12px; height: 12px"><hx-icon name="chevron-down" size="sm" /></span>
          Text channels
        </button>
        @if (store.canManageChannels()) {
          <button class="ibtn" aria-label="Create text channel" title="Create channel" (click)="create('text')" style="width: 24px; height: 24px; margin-top: 10px; flex: none"><hx-icon name="plus" size="sm" /></button>
        }
      </div>
      @if (textOpen()) {
        <div style="display: flex; flex-direction: column; gap: 2px">
          @for (c of store.textChannels(); track c.id) {
            <a class="ch" [class.unread]="badges.unread(c.id) > 0" [routerLink]="['/s', c.serverId, 'c', c.id]" routerLinkActive="on"
               ariaCurrentWhenActive="page" (click)="layout.navOpen.set(false)">
              <hx-icon name="hash" size="sm" />
              <span class="nm" dir="auto">{{ c.name }}</span>
              @if (badges.mentions(c.id); as m) {
                <span class="cnt m" [attr.aria-label]="m + ' mentions'">&#64;{{ m }}</span>
              } @else if (badges.unread(c.id); as u) {
                <span class="cnt" [attr.aria-label]="u + ' unread'">{{ u > 99 ? '99+' : u }}</span>
              }
            </a>
          }
        </div>
      }

      <div style="display: flex; align-items: center">
        <button class="grp" (click)="voiceOpen.set(!voiceOpen())" [attr.aria-expanded]="voiceOpen()">
          <span [style.transform]="voiceOpen() ? 'none' : 'rotate(-90deg)'" style="display: inline-flex; width: 12px; height: 12px"><hx-icon name="chevron-down" size="sm" /></span>
          Voice channels
        </button>
        @if (store.canManageChannels()) {
          <button class="ibtn" aria-label="Create voice channel" title="Create channel" (click)="create('voice')" style="width: 24px; height: 24px; margin-top: 10px; flex: none"><hx-icon name="plus" size="sm" /></button>
        }
      </div>
      @if (voiceOpen()) {
        <div style="display: flex; flex-direction: column; gap: 2px">
          @for (v of store.voiceChannels(); track v.id) {
            <hx-voice-roster [channel]="v" (picked)="layout.navOpen.set(false)" />
          }
        </div>
      }
    </div>

    <hx-voice-panel />
    <hx-user-panel />
  `,
})
export class ChannelSidebar {
  readonly store = inject(WorkspaceStore);
  readonly layout = inject(LayoutService);
  readonly badges = inject(ChannelBadges);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);

  readonly dms = inject(DirectMessages);
  private readonly session = inject(SessionService);

  readonly dmOpen = signal(true);
  readonly textOpen = signal(true);
  readonly voiceOpen = signal(true);

  /** The other person in a direct message. */
  other(c: Channel) {
    const me = this.session.userId();
    const id = c.participants?.find((p) => p !== me);
    return id ? this.store.memberById().get(id) : undefined;
  }

  invite(): void {
    openInviteDialog(this.dialog);
  }

  create(type: 'text' | 'voice'): void {
    const ref = this.dialog.open<Channel>(CreateChannelDialog, { data: { type }, ariaLabel: 'Create channel' });
    ref.closed.subscribe((ch) => {
      if (ch && ch.type === 'text') void this.router.navigate(['/s', ch.serverId, 'c', ch.id]);
    });
  }
}
