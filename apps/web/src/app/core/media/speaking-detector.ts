/**
 * Speaking rings measured in the browser. LiveKit's active-speaker updates are computed on the SFU, smoothed and sent
 * in intervals, so a ring lit up ~0.5–1 s after someone started talking. Here every watched track (my processed mic,
 * everyone's received voice) goes through an AnalyserNode and is polled every 50 ms: on as soon as the level crosses
 * ON_DB, off after HOLD_MS below OFF_DB (hysteresis, so a ring does not flicker between words).
 */
const POLL_MS = 50;
const ON_DB = -50;
const OFF_DB = -56;
const HOLD_MS = 300;

interface Watched {
  /** Returns the track to measure right now; it changes with mic processors, device switches and mute. */
  track: () => MediaStreamTrack | undefined;
  trackId?: string;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  speaking: boolean;
  quietSince: number;
}

export class SpeakingDetector {
  private ctx?: AudioContext;
  private readonly watched = new Map<string, Watched>();
  private timer?: ReturnType<typeof setInterval>;
  private buf = new Float32Array(512);
  private last = '';

  constructor(private readonly onChange: (speaking: ReadonlySet<string>) => void) {}

  /** False while the browser keeps our AudioContext suspended: callers then fall back to the server's speakers. */
  get measuring(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Ids with a track being measured (their ring comes from here, not from the server). */
  covers(id: string): boolean {
    const w = this.watched.get(id);
    return !!w && !!w.analyser && this.measuring;
  }

  watch(id: string, track: () => MediaStreamTrack | undefined): void {
    this.unwatch(id);
    this.watched.set(id, { track, speaking: false, quietSince: 0 });
    if (!this.timer) this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  unwatch(id: string): void {
    const w = this.watched.get(id);
    if (!w) return;
    this.disconnect(w);
    this.watched.delete(id);
    if (this.watched.size === 0) this.stop();
  }

  clear(): void {
    for (const w of this.watched.values()) this.disconnect(w);
    this.watched.clear();
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emit();
  }

  private poll(): void {
    const now = performance.now();
    for (const w of this.watched.values()) {
      this.attach(w);
      if (!w.analyser) {
        w.speaking = false;
        continue;
      }
      w.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const db = 10 * Math.log10(sum / this.buf.length + 1e-12);
      if (db > ON_DB) {
        w.speaking = true;
        w.quietSince = 0;
      } else if (w.speaking && db < OFF_DB) {
        if (!w.quietSince) w.quietSince = now;
        else if (now - w.quietSince >= HOLD_MS) w.speaking = false;
      }
    }
    this.emit();
  }

  /** (Re)builds the analyser when the measured track changes; a muted or ended track counts as silent. */
  private attach(w: Watched): void {
    const track = w.track();
    const usable = track && track.readyState === 'live' && track.enabled ? track : undefined;
    if (usable?.id === w.trackId && (w.analyser || !usable)) return;
    this.disconnect(w);
    w.trackId = usable?.id;
    if (!usable) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      w.source = this.ctx.createMediaStreamSource(new MediaStream([usable]));
      w.analyser = this.ctx.createAnalyser();
      w.analyser.fftSize = this.buf.length;
      w.source.connect(w.analyser);
    } catch {
      this.disconnect(w);
    }
  }

  private disconnect(w: Watched): void {
    w.source?.disconnect();
    w.source = undefined;
    w.analyser = undefined;
    w.trackId = undefined;
    w.speaking = false;
    w.quietSince = 0;
  }

  private emit(): void {
    const ids = [...this.watched].filter(([, w]) => w.speaking).map(([id]) => id).sort();
    const key = ids.join(',');
    if (key === this.last) return;
    this.last = key;
    this.onChange(new Set(ids));
  }
}
