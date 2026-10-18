import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { avatarColor, initials } from '../../shared/ui/avatar';
import { SoundboardStore } from '../soundboard/soundboard.store';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Soundboard: my volume / mute, per-friend mute, and sound management for those allowed to. */
@Component({
  selector: 'hx-soundboard-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Soundboard</h2>
    <div class="srow"><div><div class="t">Soundboard volume</div><div class="d">Only changes what you hear — separate from voice and streams</div></div>
      <div style="display: flex; align-items: center; gap: 10px; width: 260px; max-width: 100%">
        <input type="range" class="rng sbr" min="0" max="100" [value]="vol()" (input)="media.setSoundVolume(+$any($event.target).value / 100)" aria-label="Soundboard volume" style="flex: 1" />
        <span class="mono" style="font-size: 12px; width: 36px">{{ vol() }}%</span></div></div>
    <div class="srow"><div><div class="t">Mute all soundboard sounds</div><div class="d">You'll still see who played what</div></div>
      <button class="sw sbsw" aria-label="Mute soundboard" [attr.aria-pressed]="media.soundMuted()" (click)="media.setSoundMuted(!media.soundMuted())"></button></div>
    <div class="note w" style="margin-top: 16px">
      <div><b style="color: var(--tx)">Shortcuts work only while the Hangar tab is focused.</b> Browsers don't let websites listen to keys while you're in a game.</div>
    </div>

    <div class="lbl" style="margin: 28px 0 4px">Mute sounds from specific friends</div>
    @for (u of others(); track u.userId) {
      <div class="srow" style="padding: 10px 0">
        <div style="display: flex; align-items: center; gap: 10px"><span class="av s28" [style.background]="u.color">{{ u.ini }}</span><span class="t" dir="auto">{{ u.name }}</span></div>
        <button class="sw sbsw" [attr.aria-label]="'Mute ' + u.name + ' sounds'" [attr.aria-pressed]="media.soundMutedActors().has(u.userId)"
                (click)="media.setActorSoundMuted(u.userId, !media.soundMutedActors().has(u.userId))"></button>
      </div>
    } @empty {
      <div style="font-size: 12.5px; color: var(--tx3); padding: 8px 0">Nobody else is on this server yet.</div>
    }

    @if (manageable().length > 0) {
      <div class="lbl" style="margin: 28px 0 4px">Manage sounds</div>
      <div style="font-size: 12.5px; color: var(--tx3); margin-bottom: 6px">Deleting a sound stops it everywhere and removes it for everyone.</div>
      @for (s of manageable(); track s.id) {
        <div class="srow" style="padding: 8px 0">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0"><span style="font-size: 18px">{{ s.emoji ?? '🔊' }}</span><span class="t">{{ s.name }}</span>
            <span class="mono" style="font-size: 11px; color: var(--tx3)">{{ (s.durationMs / 1000).toFixed(1) }}s · {{ ownerName(s.ownerUserId) }}</span></div>
          <button class="btn ghost" (click)="sounds.remove(s)" style="color: var(--danger); height: 30px" [attr.aria-label]="'Delete ' + s.name">Delete</button>
        </div>
      }
    }
  `,
})
export class SoundboardSection {
  readonly media = inject(MediaSessionService);
  readonly sounds = inject(SoundboardStore);
  private readonly store = inject(WorkspaceStore);
  private readonly session = inject(SessionService);

  readonly vol = computed(() => Math.round(this.media.soundVolume() * 100));
  readonly manageable = computed(() => this.sounds.ready().filter((s) => s.canManage));
  readonly others = computed(() => {
    const me = this.session.userId();
    return [...this.store.memberById().values()].filter((m) => m.userId !== me)
      .map((m) => ({ userId: m.userId, name: m.displayName, color: avatarColor(m.avatarHue), ini: initials(m.displayName) }));
  });

  ownerName(id: string): string {
    return this.store.memberById().get(id)?.displayName ?? 'former member';
  }
}
