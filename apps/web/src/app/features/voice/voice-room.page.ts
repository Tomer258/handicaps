import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MediaSessionService, RoomPeer } from '../../core/media/media-session.service';
import { avatarColor, initials } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { LayoutService } from '../shell/layout.service';
import { PresenceStore } from '../presence/presence.store';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { VoicePresenceStore } from './voice-presence.store';

interface Card {
  peer: RoomPeer;
  name: string;
  color: string;
  ini: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  aria: string;
}

/** Voice channel view (prototype VOICE VIEW): join screen, participant grid, per-person volume menu, control dock. */
@Component({
  selector: 'hx-voice-room-page',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (channel(); as ch) {
      <header style="height: 52px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--line)">
        <button class="ibtn only-m" aria-label="Open channels" (click)="layout.navOpen.set(true)"><hx-icon name="menu" /></button>
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0">
          <hx-icon name="volume" style="color: var(--tx3)" />
          <h1 class="disp" style="margin: 0; font-size: 16px; font-weight: 600">{{ ch.name }}</h1>
          <span class="mono" style="font-size: 11.5px; color: var(--tx3)">{{ rosterCount() }} connected</span>
        </div>
        <button class="ibtn hide-m" [class.on]="layout.membersOpen()" aria-label="Toggle member list" [attr.aria-pressed]="layout.membersOpen()"
                title="Member list" (click)="layout.membersOpen.set(!layout.membersOpen())"><hx-icon name="users" /></button>
      </header>

      <div class="fade" style="flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; background: radial-gradient(120% 80% at 50% 0%, var(--bg3) 0%, var(--bg2) 60%)">
        @if (!here()) {
          <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center; padding: 24px">
            <h2 class="disp" style="margin: 0; font-size: 26px">{{ ch.name }}</h2>
            <p style="margin: 0; color: var(--tx2)">
              @if (rosterCount() === 0) { Nobody is here yet. } @else if (rosterCount() === 1) { 1 person hanging out } @else { {{ rosterCount() }} people hanging out }
            </p>
            @if (media.connection() === 'joining' && media.channelId() === ch.id) {
              <span class="spin" aria-label="Joining voice"></span>
            } @else {
              @if (media.error() && media.channelId() === ch.id) {
                <div class="note e" role="alert">{{ media.error() }}</div>
              }
              <button class="btn pri" style="height: 44px; padding: 0 22px" (click)="media.join(ch.id)">
                {{ media.connected() ? 'Switch to this channel' : 'Join voice' }}
              </button>
            }
          </div>
        } @else {
          <div class="scroll" style="flex: 1; min-height: 0; padding: 20px 24px 120px">
            @if (media.audioBlocked()) {
              <div class="note w" role="alert" style="margin-bottom: 14px; align-items: center">
                <span style="flex: 1">Your browser paused incoming audio.</span>
                <button class="btn pri" (click)="media.enableAudio()">Enable audio</button>
              </div>
            }
            @if (media.micBlocked()) {
              <div class="note w" role="alert" style="margin-bottom: 14px; align-items: center">
                <span style="flex: 1">Microphone unavailable — you are listen-only. Allow microphone access in the browser, then retry.</span>
                <button class="btn sec" (click)="media.retryMic()">Retry microphone</button>
              </div>
            }
            @if (cards().length === 1) {
              <div style="display: flex; align-items: center; gap: 14px; padding: 16px; border-radius: 14px; border: 1px dashed var(--line2); margin-bottom: 18px">
                <div style="flex: 1"><div style="font-weight: 600">It is just you in here</div>
                  <div style="font-size: 12.5px; color: var(--tx3)">{{ onlineFriends() }} {{ onlineFriends() === 1 ? 'friend is' : 'friends are' }} online right now.</div></div>
              </div>
            }
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px">
              @for (c of cards(); track c.peer.identity) {
                <div style="position: relative">
                  <button class="pcard" [class.talk]="c.speaking" [attr.aria-label]="c.aria" (click)="openMenu($event, c)" (contextmenu)="openMenu($event, c)">
                    <span class="av s72" [style.background]="c.color">{{ c.ini }}</span>
                    <div class="foot">
                      <span class="tag" style="font-size: 12px; font-weight: 600; letter-spacing: 0">{{ c.name }}{{ c.peer.isLocal ? ' (you)' : '' }}</span>
                      @if (c.muted) {
                        <span class="tag" style="background: var(--danger); padding: 0 5px" role="img" aria-label="Muted"><hx-icon name="mic-off" size="sm" /></span>
                      }
                      @if (c.deafened) {
                        <span class="tag" style="background: var(--danger); padding: 0 5px" role="img" aria-label="Deafened"><hx-icon name="headphones-off" size="sm" /></span>
                      }
                      <span style="flex: 1"></span>
                      @if (!c.peer.isLocal && media.volumeOf(c.peer.userId) !== 1) {
                        <span class="tag mono" [title]="'Your volume for ' + c.name">{{ pct(media.volumeOf(c.peer.userId)) }}%</span>
                      }
                    </div>
                  </button>
                </div>
              }
            </div>
          </div>

          <div style="position: absolute; left: 0; right: 0; bottom: 20px; display: flex; justify-content: center; pointer-events: none">
            <div class="dock" style="pointer-events: auto" role="toolbar" aria-label="Voice controls">
              <button class="dbtn" [class.bad]="media.muted() || media.deafened()" [attr.aria-label]="micLabel()" [attr.aria-pressed]="media.muted()"
                      [title]="micLabel()" (click)="media.toggleMute()" [disabled]="!media.canSpeak()">
                <hx-icon [name]="media.muted() || media.deafened() ? 'mic-off' : 'mic'" size="lg" />
              </button>
              <button class="dbtn" [class.bad]="media.deafened()" [attr.aria-label]="media.deafened() ? 'Undeafen' : 'Deafen'"
                      [attr.aria-pressed]="media.deafened()" [title]="media.deafened() ? 'Undeafen' : 'Deafen'" (click)="media.toggleDeafen()">
                <hx-icon [name]="media.deafened() ? 'headphones-off' : 'headphones'" size="lg" />
              </button>
              <span style="width: 1px; height: 28px; background: var(--line2)"></span>
              <button class="dbtn" aria-label="Camera (coming soon)" title="Camera — coming soon" disabled style="opacity: .45"><hx-icon name="camera" size="lg" /></button>
              <button class="dbtn" aria-label="Share screen (coming soon)" title="Screen share — coming soon" disabled style="opacity: .45"><hx-icon name="screen" size="lg" /></button>
              <button class="dbtn sb" aria-label="Soundboard (coming soon)" title="Soundboard — coming soon" disabled style="opacity: .45"><hx-icon name="soundboard" size="lg" /></button>
              <span style="width: 1px; height: 28px; background: var(--line2)"></span>
              <button class="dbtn leave" aria-label="Disconnect" title="Disconnect" (click)="media.leave()"><hx-icon name="hangup" size="lg" /></button>
            </div>
          </div>
        }

        @if (menu(); as m) {
          <div style="position: absolute; inset: 0; z-index: 35" (click)="menu.set(null)" (contextmenu)="$event.preventDefault(); menu.set(null)"></div>
          <div class="pop fade" role="menu" [attr.aria-label]="m.card.name + ' options'"
               [style.left.px]="m.x" [style.top.px]="m.y" style="position: absolute; width: 240px; padding: 6px; z-index: 36" (keydown.escape)="menu.set(null)">
            <div style="display: flex; align-items: center; gap: 10px; padding: 8px 10px 10px">
              <span class="av s28" [style.background]="m.card.color">{{ m.card.ini }}</span><b>{{ m.card.name }}</b>
            </div>
            @if (!m.card.peer.isLocal) {
              <div style="padding: 6px 10px">
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--tx3); margin-bottom: 6px">
                  <span>User volume</span><span class="mono">{{ pct(media.volumeOf(m.card.peer.userId)) }}%</span>
                </div>
                <input type="range" class="rng" min="0" max="200" step="5" [value]="pct(media.volumeOf(m.card.peer.userId))"
                       (input)="media.setVolume(m.card.peer.userId, +$any($event.target).value / 100)" [attr.aria-label]="m.card.name + ' volume'" style="width: 100%" />
              </div>
              <button class="menu-i" role="menuitemcheckbox" [attr.aria-checked]="media.volumeOf(m.card.peer.userId) === 0" (click)="toggleLocalMute(m.card.peer.userId)">
                <hx-icon name="mic-off" size="sm" /><span style="flex: 1">Mute for me</span>
                <span class="sw" [attr.aria-pressed]="media.volumeOf(m.card.peer.userId) === 0" style="transform: scale(.8)"></span>
              </button>
            } @else {
              <div style="padding: 4px 10px 8px; font-size: 12.5px; color: var(--tx3)">This is you. Use the dock to mute or deafen.</div>
            }
          </div>
        }
      </div>
    }
  `,
  host: { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column' },
})
export class VoiceRoomPage {
  readonly channelId = input.required<string>();

  readonly media = inject(MediaSessionService);
  readonly layout = inject(LayoutService);
  private readonly store = inject(WorkspaceStore);
  private readonly roster = inject(VoicePresenceStore);
  private readonly presence = inject(PresenceStore);

  readonly menu = signal<{ card: Card; x: number; y: number } | null>(null);
  private readonly restoreVolume = new Map<string, number>();

  readonly channel = computed(() => this.store.channel(this.channelId()));
  readonly here = computed(() => this.media.connected() && this.media.channelId() === this.channelId());
  readonly rosterCount = computed(() => (this.here() ? this.media.peers().length : this.roster.inChannel(this.channelId()).length));
  readonly micLabel = computed(() => (!this.media.canSpeak() ? 'You cannot speak in this channel' : this.media.muted() || this.media.deafened() ? 'Unmute' : 'Mute'));
  readonly onlineFriends = computed(() => {
    const me = this.store.memberById();
    return [...me.keys()].filter((id) => this.presence.status(id) !== 'offline').length - 1;
  });

  readonly cards = computed<Card[]>(() => {
    const members = this.store.memberById();
    const flags = this.roster.byUser();
    const speaking = this.media.speaking();
    return this.media.peers().map((peer) => {
      const m = members.get(peer.userId);
      const name = m?.displayName ?? peer.name;
      const deafened = peer.isLocal ? this.media.deafened() : !!flags.get(peer.userId)?.deafened;
      const muted = peer.isLocal ? this.media.muted() || this.media.deafened() : peer.micMuted || deafened;
      return {
        peer,
        name,
        color: avatarColor(m?.avatarHue ?? 210),
        ini: initials(name),
        speaking: speaking.has(peer.userId) && !muted,
        muted,
        deafened,
        aria: `${name}${muted ? ', muted' : ''}${deafened ? ', deafened' : ''}${speaking.has(peer.userId) ? ', speaking' : ''}`,
      };
    });
  });

  openMenu(e: MouseEvent, card: Card): void {
    e.preventDefault();
    const host = (e.currentTarget as HTMLElement).closest('.fade') as HTMLElement | null;
    const rect = host?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const x = Math.min(e.clientX - rect.left, rect.width - 250);
    const y = Math.min(e.clientY - rect.top, rect.height - 200);
    this.menu.set({ card, x: Math.max(8, x), y: Math.max(8, y) });
  }

  toggleLocalMute(userId: string): void {
    const v = this.media.volumeOf(userId);
    if (v === 0) {
      this.media.setVolume(userId, this.restoreVolume.get(userId) ?? 1);
    } else {
      this.restoreVolume.set(userId, v);
      this.media.setVolume(userId, 0);
    }
  }

  pct(v: number): number {
    return Math.round(v * 100);
  }
}
