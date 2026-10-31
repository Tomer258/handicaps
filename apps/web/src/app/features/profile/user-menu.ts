import { ChangeDetectionStrategy, Component, ElementRef, Injectable, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Perm } from '../../core/api/models';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { ToastService } from '../../core/ui/toast.service';
import { Avatar } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { VoicePresenceStore } from '../voice/voice-presence.store';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ProfileService } from './profile.service';

const WIDTH = 240;

interface UserMenuRequest {
  userId: string;
  x: number;
  y: number;
  trigger: HTMLElement | null;
}

/** Right-click menu for a person (sidebar voice list, member list): volume, mute for me, moderation. */
@Injectable({ providedIn: 'root' })
export class UserMenuService {
  readonly open = signal<UserMenuRequest | null>(null);

  show(e: MouseEvent, userId: string): void {
    e.preventDefault();
    e.stopPropagation();
    this.open.set({ userId, x: e.clientX, y: e.clientY, trigger: e.currentTarget as HTMLElement | null });
  }

  close(): void {
    const req = this.open();
    this.open.set(null);
    req?.trigger?.focus();
  }
}

@Component({
  selector: 'hx-user-menu',
  imports: [Avatar, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as v) {
      <div style="position: fixed; inset: 0; z-index: 33" (click)="menus.close()" (contextmenu)="$event.preventDefault(); menus.close()"></div>
      <div #menu class="pop fade" role="menu" [attr.aria-label]="v.name + ' options'" tabindex="-1" (keydown.escape)="menus.close()"
           [style.left.px]="pos().left" [style.top.px]="pos().top" style="position: fixed; width: 240px; padding: 6px; z-index: 34; outline: none">
        <div style="display: flex; align-items: center; gap: 10px; padding: 8px 10px 10px">
          <hx-avatar [name]="v.name" [hue]="v.hue" [assetId]="v.assetId" [size]="28" /><b dir="auto">{{ v.name }}</b>
        </div>
        <button class="menu-i" role="menuitem" (click)="profile(v.userId)"><hx-icon name="user" size="sm" /><span style="flex: 1">Profile</span></button>
        @if (!v.isMe) {
          <div style="padding: 6px 10px">
            <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--tx3); margin-bottom: 6px">
              <span>User volume</span><span class="mono">{{ v.volume }}%</span>
            </div>
            <input type="range" class="rng" min="0" max="200" step="5" [value]="v.volume" style="width: 100%"
                   (input)="media.setVolume(v.userId, +$any($event.target).value / 100)" [attr.aria-label]="v.name + ' volume'" />
          </div>
          <button class="menu-i" role="menuitemcheckbox" [attr.aria-checked]="v.volume === 0" (click)="media.toggleLocalMute(v.userId)">
            <hx-icon name="mic-off" size="sm" /><span style="flex: 1">Mute for me</span>
            <span class="sw" [attr.aria-pressed]="v.volume === 0" style="transform: scale(.8)"></span>
          </button>
          <button class="menu-i" role="menuitemcheckbox" [attr.aria-checked]="v.soundsMuted" (click)="media.setActorSoundMuted(v.userId, !v.soundsMuted)">
            <hx-icon name="soundboard" size="sm" style="color: var(--sb)" /><span style="flex: 1">Mute their soundboard</span>
            <span class="sw sbsw" [attr.aria-pressed]="v.soundsMuted" style="transform: scale(.8)"></span>
          </button>
          @if (v.canMute || v.canDisconnect) {
            <div style="height: 1px; background: var(--line); margin: 6px 4px"></div>
            @if (v.canMute) {
              <button class="menu-i" role="menuitemcheckbox" [attr.aria-checked]="v.serverMuted" (click)="serverMute(v.userId, v.name, v.serverMuted)">
                <hx-icon name="shield" size="sm" style="color: var(--danger)" /><span style="flex: 1">Server mute</span>
                <span class="sw" [attr.aria-pressed]="v.serverMuted" style="transform: scale(.8)"></span>
              </button>
            }
            @if (v.canDisconnect) {
              <button class="menu-i" role="menuitem" style="color: var(--danger)" (click)="disconnect(v.userId, v.name)">
                <hx-icon name="hangup" size="sm" /><span style="flex: 1">Disconnect from voice</span>
              </button>
            }
          }
        } @else {
          <div style="padding: 4px 10px 8px; font-size: 12.5px; color: var(--tx3)">This is you. Use the voice controls to mute or deafen.</div>
        }
      </div>
    }
  `,
})
export class UserMenu {
  readonly menus = inject(UserMenuService);
  readonly media = inject(MediaSessionService);
  private readonly profiles = inject(ProfileService);
  private readonly store = inject(WorkspaceStore);
  private readonly voice = inject(VoicePresenceStore);
  private readonly session = inject(SessionService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  readonly view = computed(() => {
    const req = this.menus.open();
    if (!req) return null;
    const m = this.store.memberById().get(req.userId);
    const inVoice = this.voice.byUser().get(req.userId);
    // Moderation follows the permissions of the voice channel they are in (as in the voice room's card menu).
    const perms = inVoice ? (this.store.channel(inVoice.channelId)?.permissions ?? 0) : 0;
    return {
      userId: req.userId,
      name: m?.displayName ?? 'Unknown',
      hue: m?.avatarHue ?? 200,
      assetId: m?.avatarAssetId ?? null,
      isMe: req.userId === this.session.userId(),
      volume: Math.round(this.media.volumeOf(req.userId) * 100),
      soundsMuted: this.media.soundMutedActors().has(req.userId),
      serverMuted: !!inVoice?.serverMuted,
      canMute: !!inVoice && (perms & Perm.MuteMembers) !== 0,
      canDisconnect: !!inVoice && (perms & Perm.RemoveFromVoice) !== 0,
    };
  });

  /** At the cursor, kept inside the window. */
  readonly pos = computed(() => {
    const req = this.menus.open();
    const height = 330;
    return {
      left: Math.max(8, Math.min((req?.x ?? 0), innerWidth - WIDTH - 8)),
      top: Math.max(8, Math.min((req?.y ?? 0), innerHeight - height)),
    };
  });

  constructor() {
    effect(() => {
      const el = this.menu()?.nativeElement;
      if (el) queueMicrotask(() => el.focus());
    });
    this.session.onTeardown(() => this.menus.open.set(null));
  }

  profile(userId: string): void {
    const trigger = this.menus.open()?.trigger ?? null;
    this.menus.open.set(null);
    this.profiles.show(userId, trigger ? ({ currentTarget: trigger, stopPropagation: () => undefined } as unknown as Event) : undefined);
  }

  async serverMute(userId: string, name: string, muted: boolean): Promise<void> {
    const serverId = this.store.serverId();
    this.menus.close();
    if (!serverId) return;
    try {
      await this.api.put(`/servers/${serverId}/members/${userId}/voice/mute`, { muted: !muted });
      this.toast.show(muted ? `Lifted server mute for ${name}` : `Server-muted ${name}`);
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
    }
  }

  async disconnect(userId: string, name: string): Promise<void> {
    const serverId = this.store.serverId();
    this.menus.close();
    if (!serverId) return;
    try {
      await this.api.delete(`/servers/${serverId}/members/${userId}/voice`);
      this.toast.show(`Disconnected ${name} from voice`);
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'warn');
    }
  }
}
