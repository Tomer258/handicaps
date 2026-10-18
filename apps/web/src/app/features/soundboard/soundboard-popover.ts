import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { REJECT_REASONS, Sound, SoundboardStore } from './soundboard.store';
import { SoundUploadDialog } from './sound-upload.dialog';

type Category = 'all' | 'favorites' | 'mine';

/** Soundboard popover from the voice dock (prototype SOUNDBOARD POPOVER, Concept A). Plays to everyone in the call. */
@Component({
  selector: 'hx-soundboard-popover',
  imports: [Icon, SoundUploadDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="position: absolute; inset: 0; z-index: 24" (click)="closed.emit()" aria-hidden="true"></div>
    <div class="pop fade" role="dialog" aria-label="Soundboard" (keydown.escape)="closed.emit()"
         style="position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); width: 384px; max-width: calc(100% - 24px);
                max-height: calc(100% - 120px); display: flex; flex-direction: column; z-index: 25; border-color: color-mix(in oklab,var(--sb) 35%,var(--line2))">
      <div style="display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px">
        <span style="width: 28px; height: 28px; border-radius: 8px; background: color-mix(in oklab,var(--sb) 22%,transparent); color: var(--sb); display: grid; place-items: center"><hx-icon name="soundboard" size="sm" /></span>
        <div style="flex: 1; min-width: 0"><b class="disp" style="font-size: 16px">Soundboard</b>
          <div style="font-size: 11.5px; color: var(--tx3)">Plays to everyone in {{ channelName() }}</div></div>
        <button class="ibtn" aria-label="Close soundboard" (click)="closed.emit()"><hx-icon name="x" size="sm" /></button>
      </div>

      <div style="padding: 0 14px 10px; display: flex; flex-direction: column; gap: 10px">
        <div style="display: flex; align-items: center; gap: 10px">
          <button class="ibtn" [class.on]="media.soundMuted()" [attr.aria-label]="media.soundMuted() ? 'Unmute soundboard' : 'Mute soundboard for me'"
                  [attr.aria-pressed]="media.soundMuted()" [title]="media.soundMuted() ? 'Unmute soundboard' : 'Mute soundboard for me'"
                  (click)="media.setSoundMuted(!media.soundMuted())" style="width: 28px; height: 28px">
            <hx-icon [name]="media.soundMuted() ? 'volume-x' : 'volume'" size="sm" />
          </button>
          <input type="range" class="rng sbr" min="0" max="100" [value]="volPct()" (input)="media.setSoundVolume(+$any($event.target).value / 100)"
                 aria-label="Soundboard volume (only for you)" style="flex: 1" />
          <span class="mono" style="font-size: 11px; color: var(--tx3); width: 34px">{{ volPct() }}%</span>
        </div>
        @if (media.soundMuted()) {
          <div class="note w" style="padding: 8px 10px">Soundboard muted for you. Friends still hear sounds you play.</div>
        }
        <div style="display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border-radius: 9px; background: var(--bg1); border: 1px solid var(--line)">
          <hx-icon name="search" size="sm" style="color: var(--tx3)" />
          <input aria-label="Search sounds" [placeholder]="'Search ' + store.ready().length + ' sounds'" [value]="query()" (input)="query.set($any($event.target).value)"
                 style="flex: 1; background: none; border: 0; outline: none; height: 30px; color: inherit" />
        </div>
        <div class="scroll" style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px" role="group" aria-label="Category">
          <button class="cat" [attr.aria-pressed]="cat() === 'all'" (click)="cat.set('all')">All</button>
          <button class="cat" [attr.aria-pressed]="cat() === 'favorites'" (click)="cat.set('favorites')">Favorites</button>
          <button class="cat" [attr.aria-pressed]="cat() === 'mine'" (click)="cat.set('mine')">My uploads</button>
        </div>
        @for (p of nowPlaying(); track p.id) {
          <div class="fade" style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; background: color-mix(in oklab,var(--sb) 14%,transparent); font-size: 12.5px">
            <span class="eq" style="color: var(--sb)"><i></i><i></i><i></i></span>
            <b>{{ p.name }}</b><span style="color: var(--tx3); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">played by {{ p.by }}</span>
            @if (p.mine) {
              <button class="ibtn" style="width: 24px; height: 24px" [attr.aria-label]="'Stop ' + p.name" title="Stop" (click)="store.stop(p.id)"><hx-icon name="stop" size="sm" /></button>
            }
          </div>
        }
        @if (store.cooldownLeftMs() > 0) {
          <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--warn)" role="status">
            <hx-icon name="timer" size="sm" />Cooldown — play again in {{ cooldownS() }}s
          </div>
        }
      </div>

      <div class="scroll" style="flex: 1; min-height: 0; padding: 0 14px 12px">
        @if (!store.catalog()) {
          <div style="padding: 24px 0; display: grid; place-items: center"><span class="spin" aria-label="Loading sounds"></span></div>
        } @else {
          @if (showRecent()) {
            <div class="lbl" style="margin: 2px 0 8px">Recently played</div>
            <div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap">
              @for (s of store.recent(); track s.id) {
                <button class="chip" (click)="store.play(s)" [disabled]="!canPlay()" style="background: var(--bg3); border: 1px solid var(--line)"
                        [attr.aria-label]="'Play ' + s.name"><span>{{ s.emoji ?? '🔊' }}</span>{{ s.name }}</button>
              }
            </div>
            <div class="lbl" style="margin: 0 0 8px">All sounds</div>
          }
          @if (cat() === 'mine' && processing().length > 0) {
            <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px">
              @for (s of processing(); track s.id) {
                <div class="note" [class.e]="s.state === 'rejected'" style="padding: 8px 10px; align-items: center">
                  @if (s.state === 'pending') { <span class="spin" style="width: 14px; height: 14px"></span> } @else { <hx-icon name="alert-circle" size="sm" style="color: var(--danger)" /> }
                  <div style="flex: 1; min-width: 0"><b>{{ s.name }}</b>
                    <div style="font-size: 12px; color: var(--tx3)">{{ s.state === 'pending' ? 'Processing…' : rejectText(s) }}</div></div>
                  @if (s.state === 'rejected') {
                    <button class="ibtn" style="width: 26px; height: 26px" [attr.aria-label]="'Remove ' + s.name" (click)="store.remove(s)"><hx-icon name="trash" size="sm" /></button>
                  }
                </div>
              }
            </div>
          }
          @if (tiles().length === 0) {
            <div style="padding: 24px 0; text-align: center; color: var(--tx3); font-size: 13px">
              @if (query()) { No sounds match “{{ query() }}”. }
              @else if (cat() === 'favorites') { Star a sound to keep it here. }
              @else if (cat() === 'mine') { You haven't uploaded any sounds yet. }
              @else { No sounds yet — upload the first one. }
            </div>
          }
          <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px">
            @for (s of tiles(); track s.id) {
              <div class="stwrap" style="position: relative">
                <button class="stile" [class.play]="store.progressOf(s.id) !== null" [class.cool]="!canPlay() && store.progressOf(s.id) === null"
                        (click)="store.play(s)" (contextmenu)="openMenu($event, s)" [attr.aria-label]="'Play ' + s.name"
                        [title]="s.name + ' · uploaded by ' + ownerName(s)" [disabled]="!canPlay()">
                  <span class="em">{{ s.emoji ?? '🔊' }}</span><span class="sn">{{ s.name }}</span>
                  <span class="sd mono">{{ (s.durationMs / 1000).toFixed(1) }}s</span>
                  @if (store.progressOf(s.id) !== null) {
                    <span class="wv"><i></i><i></i><i></i><i></i></span><span class="prog" [style.width.%]="store.progressOf(s.id)"></span>
                  }
                </button>
                <button class="fav" [class.on]="s.favorite" [attr.aria-label]="(s.favorite ? 'Remove ' : 'Add ') + s.name + (s.favorite ? ' from favorites' : ' to favorites')"
                        [attr.aria-pressed]="s.favorite" (click)="store.toggleFavorite(s)"><hx-icon name="star" size="sm" /></button>
              </div>
            }
          </div>
        }
      </div>

      <div style="display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line)">
        <button class="btn sec" style="flex: 1" (click)="uploadOpen.set(true)" [disabled]="!store.catalog()?.canUpload"><hx-icon name="upload" size="sm" />Upload sound</button>
      </div>

      @if (menu(); as m) {
        <div style="position: absolute; inset: 0; z-index: 2" (click)="menu.set(null)" (contextmenu)="$event.preventDefault(); menu.set(null)"></div>
        <div class="pop fade" role="menu" [attr.aria-label]="m.sound.name + ' options'" [style.left.px]="m.x" [style.top.px]="m.y"
             style="position: absolute; width: 190px; padding: 6px; z-index: 3" (keydown.escape)="menu.set(null)">
          <button class="menu-i" role="menuitem" (click)="menu.set(null); store.playPreview(m.sound)"><hx-icon name="play" size="sm" /><span style="flex: 1">Preview for me</span></button>
          @if (m.sound.canManage) {
            <button class="menu-i" role="menuitem" style="color: var(--danger)" (click)="menu.set(null); store.remove(m.sound)"><hx-icon name="trash" size="sm" /><span style="flex: 1">Delete sound</span></button>
          }
        </div>
      }
    </div>
    @if (uploadOpen()) {
      <hx-sound-upload-dialog (closed)="uploadOpen.set(false); cat.set('mine')" />
    }
  `,
})
export class SoundboardPopover {
  readonly channelName = input('voice');
  readonly closed = output<void>();

  readonly store = inject(SoundboardStore);
  readonly media = inject(MediaSessionService);
  private readonly workspace = inject(WorkspaceStore);
  private readonly session = inject(SessionService);

  readonly query = signal('');
  readonly cat = signal<Category>('all');
  readonly uploadOpen = signal(false);
  readonly menu = signal<{ sound: Sound; x: number; y: number } | null>(null);

  readonly volPct = computed(() => Math.round(this.media.soundVolume() * 100));
  readonly cooldownS = computed(() => Math.ceil(this.store.cooldownLeftMs() / 1000));
  readonly canPlay = computed(() => this.store.inVoice() && this.store.cooldownLeftMs() === 0 && !this.store.busy());
  readonly showRecent = computed(() => this.cat() === 'all' && !this.query() && this.store.recent().length > 0);
  readonly processing = computed(() => this.store.sounds().filter((s) => s.state !== 'ready' && s.ownerUserId === this.session.user()?.id));

  readonly tiles = computed(() => {
    const q = this.query().trim().toLowerCase();
    const me = this.session.user()?.id;
    return this.store.ready().filter((s) =>
      (this.cat() === 'all' || (this.cat() === 'favorites' ? s.favorite : s.ownerUserId === me)) && (!q || s.name.toLowerCase().includes(q)));
  });

  readonly nowPlaying = computed(() => {
    const me = this.session.user()?.id;
    return this.store.playing().map((p) => ({
      id: p.playbackId,
      name: this.store.byId().get(p.soundId)?.name ?? 'A sound',
      by: p.actorUserId === me ? 'you' : (this.workspace.memberById().get(p.actorUserId)?.displayName ?? 'someone'),
      mine: p.actorUserId === me,
    }));
  });

  ownerName(s: Sound): string {
    return this.workspace.memberById().get(s.ownerUserId)?.displayName ?? 'a former member';
  }

  rejectText(s: Sound): string {
    return REJECT_REASONS[s.rejectReason ?? ''] ?? 'This file could not be used.';
  }

  openMenu(e: MouseEvent, sound: Sound): void {
    e.preventDefault();
    const host = (e.currentTarget as HTMLElement).closest('[role=dialog]') as HTMLElement;
    const rect = host.getBoundingClientRect();
    this.menu.set({ sound, x: Math.max(8, Math.min(e.clientX - rect.left, rect.width - 200)), y: Math.max(8, Math.min(e.clientY - rect.top, rect.height - 100)) });
  }
}
