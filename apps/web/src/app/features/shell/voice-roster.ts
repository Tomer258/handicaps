import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { Channel } from '../../core/api/models';
import { MediaSessionService } from '../../core/media/media-session.service';
import { VoicePresenceStore } from '../voice/voice-presence.store';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Avatar } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';

/** A voice channel row in the sidebar with the people currently connected. */
@Component({
  selector: 'hx-voice-roster',
  imports: [Avatar, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div>
      <button class="ch" [class.on]="isCurrent()" (click)="open()" [title]="hint()">
        <hx-icon name="volume" size="sm" />
        <span class="nm" dir="auto">{{ channel().name }}</span>
        @if (liveCount() > 0) {
          <span class="tag live" style="height: 18px; font-size: 10px; padding: 0 6px">LIVE {{ liveCount() }}</span>
        }
        @if (people().length > 0) {
          <span class="mono" style="font-size: 11px; color: var(--tx3)">{{ people().length }}</span>
        }
      </button>
      @for (p of people(); track p.userId) {
        <div class="vp" role="group" [attr.aria-label]="p.name + (p.muted ? ', muted' : '') + (p.deafened ? ', deafened' : '') + (p.screen ? ', live' : '')">
          <hx-avatar [name]="p.name" [hue]="p.hue" [assetId]="p.assetId" [size]="20" [speaking]="media.speaking().has(p.userId)" />
          <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" dir="auto"
                [style.color]="media.speaking().has(p.userId) ? 'var(--tx)' : null">{{ p.name }}</span>
          @if (p.screen) { <span class="tag live" style="height: 16px; font-size: 9.5px; padding: 0 5px">LIVE</span> }
          @if (p.camera) { <span style="color: var(--tx3); display: inline-flex" role="img" aria-label="Camera on"><hx-icon name="camera" size="sm" /></span> }
          @if (p.muted || p.serverMuted) { <span style="color: var(--danger); display: inline-flex" role="img" aria-label="Muted"><hx-icon name="mic-off" size="sm" /></span> }
          @if (p.deafened) { <span style="color: var(--danger); display: inline-flex" role="img" aria-label="Deafened"><hx-icon name="headphones-off" size="sm" /></span> }
        </div>
      }
    </div>
  `,
})
export class VoiceRoster {
  readonly channel = input.required<Channel>();
  readonly picked = output<void>();

  readonly media = inject(MediaSessionService);
  private readonly presence = inject(VoicePresenceStore);
  private readonly store = inject(WorkspaceStore);
  private readonly router = inject(Router);

  readonly isCurrent = computed(() => this.media.channelId() === this.channel().id && this.media.connected());
  readonly people = computed(() =>
    this.presence.inChannel(this.channel().id).map((m) => {
      const member = this.store.memberById().get(m.userId);
      return { ...m, name: member?.displayName ?? 'Unknown', hue: member?.avatarHue ?? 200, assetId: member?.avatarAssetId ?? null };
    }),
  );
  readonly liveCount = computed(() => this.people().filter((p) => p.screen).length);
  readonly hint = computed(() => (this.isCurrent() ? 'Open voice view' : `Join ${this.channel().name}`));

  open(): void {
    this.picked.emit();
    const ch = this.channel();
    void this.router.navigate(['/s', ch.serverId, 'v', ch.id]);
    // Clicking a voice channel joins it (switching from another one), like the desktop clients.
    if (!this.isCurrent()) void this.media.join(ch.id);
  }
}
