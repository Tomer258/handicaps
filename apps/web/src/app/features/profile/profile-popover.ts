import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { Perm } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { PreferredStatus, UserSettingsService } from '../../core/settings/user-settings.service';
import { Avatar, avatarColor } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { ago } from '../../shared/ui/time-ago';
import { ChatStore } from '../messages/chat.store';
import { PresenceStore } from '../presence/presence.store';
import { openUserSettings } from '../settings/settings.dialog';
import { VoicePresenceStore } from '../voice/voice-presence.store';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ProfileService } from './profile.service';

const WIDTH = 320;
const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' } as const;
const MY_STATUS: { id: PreferredStatus; label: string; color: string }[] = [
  { id: 'online', label: 'Online', color: 'var(--online)' },
  { id: 'idle', label: 'Idle', color: 'var(--idle)' },
  { id: 'doNotDisturb', label: 'Do not disturb', color: 'var(--dnd)' },
  { id: 'invisible', label: 'Invisible', color: 'var(--offline)' },
];

/** UserProfilePopover (Handoff): 320px card; self → status picker, friend → mention / mute / sounds, friend in my voice → volume. */
@Component({
  selector: 'hx-profile-popover',
  imports: [Avatar, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as v) {
      <div style="position: fixed; inset: 0; z-index: 33" (click)="profiles.close()" (contextmenu)="$event.preventDefault(); profiles.close()"></div>
      <div #card class="pop fade" role="dialog" [attr.aria-label]="v.name + ' profile'" tabindex="-1" (keydown.escape)="profiles.close()"
           [style.left.px]="pos().left" [style.top.px]="pos().top"
           style="position: fixed; width: 320px; overflow: hidden; z-index: 34; outline: none">
        <div style="height: 84px" [style.background]="v.banner"></div>
        <div style="padding: 0 16px 16px; margin-top: -40px">
          <div style="display: flex; align-items: flex-end; justify-content: space-between">
            <span style="border-radius: 50%; border: 5px solid var(--bg2); display: inline-flex">
              <hx-avatar [name]="v.name" [hue]="v.hue" [assetId]="v.assetId" [size]="80" [status]="v.status" surface="var(--bg2)" />
            </span>
            <div style="display: flex; gap: 6px; padding-bottom: 6px">
              @for (b of v.badges; track b) {
                <span [class]="b === 'LIVE' ? 'tag live' : ''" [style]="b === 'LIVE' ? '' : 'font-size: 10.5px; font-weight: 600; letter-spacing: .06em; padding: 3px 7px; border-radius: 6px; background: var(--bg4); color: var(--tx2)'">{{ b }}</span>
              }
            </div>
          </div>
          <div class="disp" style="font-size: 20px; font-weight: 700; margin-top: 8px" dir="auto">{{ v.name }}</div>
          <div class="mono" style="font-size: 12px; color: var(--tx3)">&#64;{{ v.login }} · {{ v.statusLabel }}</div>
          @if (v.joined) {
            <div style="margin-top: 10px; font-size: 12.5px; color: var(--tx3)" data-testid="profile-joined">{{ v.joined }}</div>
          }
          @if (v.lastHere) {
            <div style="margin-top: 10px; font-size: 13px; color: var(--tx2)">Last here {{ v.lastHere }}</div>
          }

          @if (v.isMe) {
            <div class="lbl" style="margin: 14px 0 8px">Set status</div>
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px" role="group" aria-label="Status">
              @for (o of myStatus; track o.id) {
                <button class="menu-i" [attr.aria-pressed]="settings.preferredStatus() === o.id" (click)="settings.setStatus(o.id)"
                        [style.background]="settings.preferredStatus() === o.id ? 'var(--bg4)' : 'transparent'">
                  <span style="width: 10px; height: 10px; border-radius: 50%" [style.background]="o.color"></span>{{ o.label }}
                </button>
              }
            </div>
            <button class="btn sec" style="width: 100%; margin-top: 12px" (click)="editProfile()">Edit profile</button>
          } @else {
            @if (v.inMyVoice) {
              <div style="margin-top: 14px">
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--tx3); margin-bottom: 6px">
                  <span>Voice volume</span><span class="mono">{{ v.volume }}%</span>
                </div>
                <input type="range" class="rng" min="0" max="200" step="5" [value]="v.volume" style="width: 100%"
                       (input)="media.setVolume(v.userId, +$any($event.target).value / 100)" [attr.aria-label]="v.name + ' volume'" />
              </div>
            }
            <div style="display: flex; gap: 8px; margin-top: 14px">
              @if (v.canMention) {
                <button class="btn pri" style="flex: 1" (click)="mention(v.login)">Mention</button>
              }
              <button class="btn sec" [attr.aria-pressed]="v.localMuted" (click)="toggleMute(v.userId)" [title]="v.localMuted ? 'Hear their voice again' : 'Mute their voice for you'">
                {{ v.localMuted ? 'Unmute' : 'Mute' }}
              </button>
              <button class="btn sec" [attr.aria-pressed]="v.soundsMuted" (click)="media.setActorSoundMuted(v.userId, !v.soundsMuted)" title="Mute their soundboard sounds" style="color: var(--sb)">
                <hx-icon name="soundboard" size="sm" />{{ v.soundsMuted ? 'Sounds off' : 'Sounds' }}
              </button>
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class ProfilePopover {
  readonly profiles = inject(ProfileService);
  readonly media = inject(MediaSessionService);
  readonly settings = inject(UserSettingsService);
  private readonly session = inject(SessionService);
  private readonly store = inject(WorkspaceStore);
  private readonly presence = inject(PresenceStore);
  private readonly voice = inject(VoicePresenceStore);
  private readonly chat = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  readonly myStatus = MY_STATUS;
  /** Remembered voice volume to restore on "Unmute". */
  private readonly restore = new Map<string, number>();

  readonly view = computed(() => {
    const req = this.profiles.open();
    if (!req) return null;
    const me = this.session.userId();
    const u = this.session.user();
    // My own card also opens outside a server (home page), from the session.
    const m = this.store.memberById().get(req.userId) ??
      (u && req.userId === me ? { userId: u.id, login: u.login, displayName: u.displayName, avatarHue: u.avatarHue, avatarAssetId: u.avatarAssetId, roleIds: [], isOwner: false, joinedAt: '', lastOnlineAt: null } : undefined);
    if (!m) return null;
    const isMe = m.userId === me;
    const status = this.presence.status(m.userId);
    const roles = this.store.server()?.roles ?? [];
    const top = roles.filter((r) => !r.isDefault && m.roleIds.includes(r.id)).sort((a, b) => b.position - a.position)[0];
    const badges = this.store.memberById().has(m.userId) ? [m.isOwner ? 'OWNER' : top ? top.name.toUpperCase() : 'MEMBER'] : [];
    if (this.voice.byUser().get(m.userId)?.screen) badges.push('LIVE');
    const offlineAt = this.presence.wentOffline()[m.userId] ?? (m.lastOnlineAt ? Date.parse(m.lastOnlineAt) : 0);
    const color = avatarColor(m.avatarHue);
    const inviter = m.invitedBy ? this.store.memberById().get(m.invitedBy)?.displayName : null;
    const joinedOn = m.joinedAt ? new Date(m.joinedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
    return {
      userId: m.userId,
      name: m.displayName,
      login: m.login,
      hue: m.avatarHue,
      assetId: m.avatarAssetId,
      banner: `linear-gradient(120deg, ${color}, var(--bg4))`,
      status,
      statusLabel: isMe ? MY_STATUS.find((s) => s.id === this.settings.preferredStatus())?.label ?? 'Online' : STATUS_LABEL[status],
      badges,
      joined: joinedOn ? `Joined ${joinedOn}${inviter ? ' · invited by ' + inviter : ''}` : '',
      lastHere: !isMe && status === 'offline' && offlineAt ? ago(Date.now() - offlineAt) : null,
      isMe,
      inMyVoice: !isMe && this.media.connected() && this.media.peers().some((p) => p.userId === m.userId),
      volume: Math.round(this.media.volumeOf(m.userId) * 100),
      localMuted: this.media.volumeOf(m.userId) === 0,
      soundsMuted: this.media.soundMutedActors().has(m.userId),
      canMention: !!this.mentionChannel(),
    };
  });

  /** Clamped to the viewport: beside the trigger, on whichever side has room. */
  readonly pos = computed(() => {
    const r = this.profiles.open()?.rect ?? { left: 0, right: 0, top: 0 };
    const left = r.left >= WIDTH + 16 ? r.left - WIDTH - 10 : Math.min(r.right + 10, innerWidth - WIDTH - 8);
    return { left: Math.max(8, left), top: Math.max(8, Math.min(r.top - 20, innerHeight - 470)) };
  });

  constructor() {
    effect(() => {
      // Focus moves into the card when it opens; Esc / outside click hand it back to the trigger.
      const el = this.card()?.nativeElement;
      if (el) queueMicrotask(() => el.focus());
    });
    this.session.onTeardown(() => this.profiles.open.set(null));
  }

  toggleMute(userId: string): void {
    const v = this.media.volumeOf(userId);
    if (v === 0) {
      this.media.setVolume(userId, this.restore.get(userId) ?? 1);
    } else {
      this.restore.set(userId, v);
      this.media.setVolume(userId, 0);
    }
  }

  mention(login: string): void {
    const ch = this.mentionChannel();
    const serverId = this.store.serverId();
    if (!ch || !serverId) return;
    this.profiles.open.set(null);
    this.chat.pendingInsert.set({ channelId: ch, text: `@${login} ` });
    if (!this.router.url.startsWith(`/s/${serverId}/c/${ch}`)) void this.router.navigate(['/s', serverId, 'c', ch]);
  }

  editProfile(): void {
    this.profiles.open.set(null);
    openUserSettings(this.dialog, 'account');
  }

  /** The open text channel if I can write there, else the first one I can. */
  private mentionChannel(): string | null {
    const text = this.store.channels().filter((c) => c.type === 'text' && (c.permissions & Perm.SendMessages) !== 0);
    const active = this.chat.activeChannelId();
    return text.find((c) => c.id === active)?.id ?? text[0]?.id ?? null;
  }
}
