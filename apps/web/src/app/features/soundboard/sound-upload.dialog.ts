import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { MediaSessionService } from '../../core/media/media-session.service';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { REJECT_REASONS, Sound, SoundboardStore } from './soundboard.store';

type Step = 'drop' | 'edit' | 'uploading' | 'processing' | 'error';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_S = 30;
const MAX_CLIP_S = 5;
const BARS = 48;
const EMOJIS = ['🔊', '📯', '💥', '😂', '🎉', '👏', '🦗', '🥁'];

/**
 * Upload a sound (prototype UPLOAD SOUND). The file is decoded locally only to draw the waveform, pick a trim
 * range and preview it; the server re-validates and normalizes everything (the client is never trusted).
 */
@Component({
  selector: 'hx-sound-upload-dialog',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close()" (keydown.escape)="close()" style="z-index: 40">
      <div class="pop fade" role="dialog" aria-modal="true" aria-labelledby="up-title" (click)="$event.stopPropagation()"
           style="width: 500px; max-width: calc(100% - 32px); padding: 22px">
        <div style="display: flex; align-items: center; gap: 12px">
          <span style="width: 36px; height: 36px; border-radius: 10px; background: var(--sb); color: #1A0A22; display: grid; place-items: center"><hx-icon name="upload" /></span>
          <div style="flex: 1"><h2 id="up-title" class="disp" style="margin: 0; font-size: 20px">Upload a sound</h2>
            <div style="font-size: 12.5px; color: var(--tx3)">Short effects only — up to 5 seconds after trimming</div></div>
          <button class="ibtn" aria-label="Close" (click)="close()"><hx-icon name="x" size="sm" /></button>
        </div>

        @switch (step()) {
          @case ('drop') {
            <label for="sfile" (dragover)="$event.preventDefault()" (drop)="onDrop($event)"
                   style="margin-top: 18px; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 34px 20px; border-radius: 14px; border: 2px dashed color-mix(in oklab,var(--sb) 55%,var(--line2)); background: color-mix(in oklab,var(--sb) 6%,var(--bg1)); cursor: pointer; text-align: center">
              <hx-icon name="music" style="width: 34px; height: 34px; color: var(--sb)" />
              <b>Drop an audio file or click to browse</b>
              <span style="font-size: 12px; color: var(--tx3)">MP3, WAV or OGG · source up to 30 s · max 5 MB</span>
            </label>
            <input id="sfile" type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/ogg,.mp3,.wav,.ogg" (change)="onPick($event)"
                   style="position: absolute; width: 1px; height: 1px; opacity: 0" aria-label="Choose audio file" />
            @if (decoding()) { <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center; color: var(--tx3); font-size: 12.5px"><span class="spin"></span>Reading file…</div> }
          }
          @case ('edit') {
            <div class="card" style="margin-top: 18px; padding: 12px; display: flex; align-items: center; gap: 12px">
              <button class="ibtn" style="width: 38px; height: 38px; background: var(--sb); color: #1A0A22; border-radius: 50%" aria-label="Preview trimmed sound" (click)="preview()">
                <hx-icon name="play" />
              </button>
              <div style="flex: 1; min-width: 0"><div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ fileName() }}</div>
                <div class="mono" style="font-size: 11.5px; color: var(--tx3)">{{ sizeText() }} · {{ total().toFixed(1) }}s total</div></div>
              <span class="tag" [class.sbt]="!tooLong()" [style.background]="tooLong() ? 'var(--danger)' : null">{{ tooLong() ? 'Too long' : 'Ready' }}</span>
            </div>
            <div style="margin-top: 14px">
              <div style="display: flex; justify-content: space-between" class="lbl"><span>Trim</span>
                <span class="mono" style="text-transform: none; letter-spacing: 0" [style.color]="tooLong() ? 'var(--danger)' : 'var(--tx2)'">{{ len().toFixed(1) }}s selected</span></div>
              <div class="wave" style="margin-top: 8px" aria-hidden="true">
                @for (b of bars(); track $index) { <i [class.in]="b.in" [style.height.%]="b.h"></i> }
              </div>
              <div style="display: flex; gap: 12px; margin-top: 8px; align-items: center">
                <label class="mono" for="ta" style="font-size: 11px; color: var(--tx3); width: 36px">Start</label>
                <input id="ta" type="range" class="rng sbr" min="0" [max]="total()" step="0.05" [value]="start()" (input)="setStart(+$any($event.target).value)" style="flex: 1" />
                <label class="mono" for="tb" style="font-size: 11px; color: var(--tx3); width: 30px">End</label>
                <input id="tb" type="range" class="rng sbr" min="0" [max]="total()" step="0.05" [value]="end()" (input)="setEnd(+$any($event.target).value)" style="flex: 1" />
              </div>
              @if (tooLong()) { <div style="font-size: 12px; color: var(--danger); margin-top: 6px">Trim to 5.0 s or less to upload.</div> }
            </div>
            <div style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin-top: 16px">
              <div class="field"><label for="sname">Sound name</label>
                <input id="sname" class="inp" maxlength="32" [value]="name()" (input)="name.set($any($event.target).value)" /></div>
              <div class="field"><span class="lbl">Icon</span>
                <div style="display: flex; gap: 4px; flex-wrap: wrap" role="radiogroup" aria-label="Icon">
                  @for (e of emojis; track e) {
                    <button role="radio" [attr.aria-checked]="emoji() === e" [attr.aria-label]="'Icon ' + e" (click)="emoji.set(e)"
                            style="width: 38px; height: 38px; border-radius: 9px; font-size: 18px"
                            [style.background]="emoji() === e ? 'color-mix(in oklab,var(--sb) 22%,transparent)' : 'var(--bg3)'"
                            [style.border]="'1px solid ' + (emoji() === e ? 'var(--sb)' : 'var(--line)')">{{ e }}</button>
                  }
                </div></div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px">
              <button class="btn ghost" (click)="close()">Cancel</button>
              <button class="btn sbb" (click)="upload()" [disabled]="tooLong() || !name().trim() || len() < 0.1">Upload to {{ serverName() }}</button>
            </div>
          }
          @case ('uploading') {
            <div style="margin-top: 22px">
              <div style="display: flex; justify-content: space-between; font-size: 13px"><span>Uploading <b>{{ name() }}</b>…</span><span class="mono">{{ progress() }}%</span></div>
              <div class="meter" style="margin-top: 10px; height: 10px"><i [style.width.%]="progress()" style="background: var(--sb)"></i></div>
            </div>
          }
          @case ('processing') {
            <div style="margin-top: 22px" role="status">
              <div style="display: flex; align-items: center; gap: 10px; font-size: 13px"><span class="spin"></span><span>Processing <b>{{ name() }}</b>…</span></div>
              <div style="font-size: 12px; color: var(--tx3); margin-top: 10px">Normalizing loudness so it won't blow out anyone's headphones. You can close this — it keeps going.</div>
            </div>
          }
          @case ('error') {
            <div class="note e" style="margin-top: 18px" role="alert">
              <hx-icon name="alert-circle" size="sm" style="color: var(--danger); margin-top: 1px" />
              <div><b style="color: var(--tx)">Upload failed</b><div>{{ error() }}</div></div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px">
              <button class="btn ghost" (click)="close()">Cancel</button>
              <button class="btn sbb" (click)="reset()">Choose another file</button>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class SoundUploadDialog {
  readonly closed = output<void>();

  private readonly api = inject(ApiService);
  private readonly store = inject(SoundboardStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly media = inject(MediaSessionService);
  private readonly toast = inject(ToastService);

  readonly emojis = EMOJIS;
  readonly step = signal<Step>('drop');
  readonly decoding = signal(false);
  readonly error = signal('');
  readonly progress = signal(0);
  readonly fileName = signal('');
  readonly name = signal('');
  readonly emoji = signal(EMOJIS[0]);
  readonly total = signal(0);
  readonly start = signal(0);
  readonly end = signal(0);
  private readonly peaks = signal<number[]>([]);
  private readonly uploadedId = signal<string | null>(null);

  private file: File | null = null;
  private buffer: AudioBuffer | null = null;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  readonly serverName = computed(() => this.workspace.server()?.name ?? 'server');
  readonly len = computed(() => Math.max(0, this.end() - this.start()));
  readonly tooLong = computed(() => this.len() > MAX_CLIP_S + 0.02);
  readonly sizeText = computed(() => {
    const kb = (this.file?.size ?? 0) / 1024;
    return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
  });
  readonly bars = computed(() => {
    const t = this.total() || 1;
    return this.peaks().map((p, i) => {
      const at = ((i + 0.5) / BARS) * t;
      return { h: Math.max(6, Math.round(p * 100)), in: at >= this.start() && at <= this.end() };
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopPreview();
      void this.ctx?.close().catch(() => undefined);
    });
    // After upload: wait for the validator verdict delivered through the catalog.
    effect(() => {
      const id = this.uploadedId();
      const sound = id ? this.store.byId().get(id) : undefined;
      if (!sound || sound.state === 'pending') return;
      untracked(() => this.finish(sound));
    });
  }

  onPick(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void this.load(f);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void this.load(f);
  }

  setStart(v: number): void {
    this.start.set(Math.min(v, Math.max(0, this.end() - 0.1)));
  }

  setEnd(v: number): void {
    this.end.set(Math.max(v, Math.min(this.total(), this.start() + 0.1)));
  }

  preview(): void {
    if (!this.buffer) return;
    this.stopPreview();
    this.ctx ??= new AudioContext();
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    gain.gain.value = this.media.soundVolume();
    src.buffer = this.buffer;
    src.connect(gain).connect(this.ctx.destination);
    src.start(0, this.start(), Math.min(this.len(), MAX_CLIP_S));
    this.source = src;
  }

  async upload(): Promise<void> {
    if (!this.file || this.tooLong()) return;
    const serverId = this.workspace.serverId();
    if (!serverId) return;
    this.stopPreview();
    const form = new FormData();
    form.append('name', this.name().trim());
    form.append('emoji', this.emoji());
    // Only send a trim when the user actually trimmed (the server trims and re-checks the length).
    if (this.start() > 0.01 || this.end() < this.total() - 0.01) {
      form.append('trimStart', this.start().toFixed(3));
      form.append('trimEnd', this.end().toFixed(3));
    }
    form.append('file', this.file, this.file.name);
    this.step.set('uploading');
    this.progress.set(0);
    try {
      const sound = await this.api.upload<Sound>(`/servers/${serverId}/sounds`, form, (p) => this.progress.set(p));
      this.store.upsertLocal(sound);
      this.step.set('processing');
      this.uploadedId.set(sound.id);
    } catch (e) {
      this.fail(ApiError.from(e).message);
    }
  }

  reset(): void {
    this.stopPreview();
    this.file = null;
    this.buffer = null;
    this.uploadedId.set(null);
    this.peaks.set([]);
    this.error.set('');
    this.step.set('drop');
  }

  close(): void {
    this.closed.emit();
  }

  private async load(f: File): Promise<void> {
    if (f.size > MAX_BYTES) return this.fail('The file is larger than 5 MB.');
    this.decoding.set(true);
    try {
      this.ctx ??= new AudioContext();
      const buffer = await this.ctx.decodeAudioData(await f.arrayBuffer());
      if (buffer.duration > MAX_SOURCE_S) return this.fail('The source file is longer than 30 seconds. Cut it down first.');
      this.file = f;
      this.buffer = buffer;
      this.fileName.set(f.name);
      this.name.set(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 32) || 'My sound');
      this.total.set(buffer.duration);
      this.start.set(0);
      this.end.set(Math.min(buffer.duration, MAX_CLIP_S));
      this.peaks.set(computePeaks(buffer));
      this.step.set('edit');
    } catch {
      this.fail("This file couldn't be read as audio. Use MP3, WAV or OGG.");
    } finally {
      this.decoding.set(false);
    }
  }

  private finish(sound: Sound): void {
    this.uploadedId.set(null);
    if (sound.state === 'ready') {
      this.toast.show(`“${sound.name}” added to the soundboard`, 'sound');
      this.close();
    } else {
      this.fail(REJECT_REASONS[sound.rejectReason ?? ''] ?? 'This file could not be used.');
    }
  }

  private fail(message: string): void {
    this.error.set(message);
    this.step.set('error');
  }

  private stopPreview(): void {
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
  }
}

/** Normalized peak per bar across all channels (for the trim waveform only). */
function computePeaks(buffer: AudioBuffer): number[] {
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const per = Math.max(1, Math.floor(buffer.length / BARS));
  const peaks: number[] = [];
  for (let b = 0; b < BARS; b++) {
    let max = 0;
    for (let i = b * per; i < Math.min(buffer.length, (b + 1) * per); i += 16)
      for (const c of chans) max = Math.max(max, Math.abs(c[i]));
    peaks.push(max);
  }
  const top = Math.max(...peaks, 0.0001);
  return peaks.map((p) => p / top);
}
