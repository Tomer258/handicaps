import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, signal, viewChild } from '@angular/core';
import { DevicesService } from '../../core/media/devices.service';
import { MediaPrefsService } from '../../core/media/media-prefs.service';
import { Icon } from '../../shared/ui/icon';

/** Video & streaming: camera choice with a live local preview, and the default go-live quality. */
@Component({
  selector: 'hx-video-section',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Video &amp; streaming</h2>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; align-items: start">
      <div style="aspect-ratio: 16/10; border-radius: 14px; overflow: hidden; border: 1px solid var(--line); position: relative; background: var(--bg0)">
        <video #preview autoplay muted playsinline [hidden]="!previewing()" style="width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1)"></video>
        @if (!previewing()) {
          <div style="position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 16px; color: var(--tx2); font-size: 12.5px">
            <div><hx-icon name="camera-off" size="lg" style="color: var(--tx3)" />
              <div style="margin-top: 6px">{{ error() || 'Camera preview is off' }}</div>
              <button class="btn sec" style="margin-top: 10px" (click)="startPreview()">Test camera</button></div>
          </div>
        } @else {
          <span class="tag" style="position: absolute; left: 8px; top: 8px">Preview — only you see this</span>
          <button class="btn sec" style="position: absolute; right: 8px; bottom: 8px; height: 30px" (click)="stopPreview()">Stop</button>
        }
      </div>
      <div class="field"><label for="cdev">Camera</label>
        <select id="cdev" class="inp" [value]="prefs.prefs().cameraDeviceId" (change)="pickCamera($any($event.target).value)">
          <option value="">System default</option>
          @for (d of devices.cameras(); track d.id) { <option [value]="d.id" [selected]="d.id === prefs.prefs().cameraDeviceId">{{ d.label }}</option> }
        </select>
        @if (devices.cameras().length === 0) { <span style="font-size: 12.5px; color: var(--tx3)">No camera detected yet. Plug one in or allow access with “Test camera”.</span> }
      </div>
    </div>
    <div class="lbl" style="margin: 26px 0 4px">Default stream quality</div>
    <div class="srow"><div><div class="t">When you go live</div><div class="d">You can still change it per stream</div></div>
      <div class="seg" role="group" aria-label="Default stream quality">
        <button [attr.aria-pressed]="prefs.prefs().streamQuality === '1080p60'" (click)="prefs.update({ streamQuality: '1080p60' })">1080p · 60</button>
        <button [attr.aria-pressed]="prefs.prefs().streamQuality === '720p30'" (click)="prefs.update({ streamQuality: '720p30' })">720p · 30</button>
      </div></div>
    <div class="note" style="margin-top: 18px">
      <hx-icon name="info" size="sm" style="color: var(--tx3); margin-top: 1px" />
      <div><b style="color: var(--tx)">Getting game audio into your stream</b><br>Chrome and Edge on Windows: choose <b>Entire screen</b> and tick “Share system audio”,
        or share a <b>tab</b> with “Share tab audio”. Single windows can't include audio in browsers. Friends hear stream audio on its own volume slider — separate from your voice.</div>
    </div>
  `,
})
export class VideoSection {
  readonly devices = inject(DevicesService);
  readonly prefs = inject(MediaPrefsService);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('preview');

  readonly previewing = signal(false);
  readonly error = signal('');
  private stream?: MediaStream;

  constructor() {
    void this.devices.refresh();
    inject(DestroyRef).onDestroy(() => this.stopPreview());
  }

  pickCamera(id: string): void {
    this.prefs.update({ cameraDeviceId: id });
    if (this.previewing()) void this.startPreview();
  }

  async startPreview(): Promise<void> {
    this.stopPreview();
    this.error.set('');
    const id = this.prefs.prefs().cameraDeviceId;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id ? { exact: id } : undefined, width: 1280, height: 720 } });
    } catch (e) {
      const name = (e as Error)?.name;
      this.error.set(name === 'NotAllowedError' ? 'Camera access was denied' : name === 'NotFoundError' ? 'No webcam detected' : 'That camera is unavailable');
      return;
    }
    this.video().nativeElement.srcObject = this.stream;
    this.previewing.set(true);
    void this.devices.refresh();
  }

  stopPreview(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.previewing.set(false);
  }
}
