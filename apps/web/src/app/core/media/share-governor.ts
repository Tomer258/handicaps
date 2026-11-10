import type { LocalVideoTrack } from 'livekit-client';

/** smooth = games and video (keeps the frame rate) · sharp = text and apps (keeps the resolution). */
export type ShareMode = 'smooth' | 'sharp';
export type EncoderKind = 'hardware' | 'software';

/** One step of a quality ladder: what the main layer sends. */
export interface Rung {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

const rung = (width: number, height: number, fps: number, bitrate: number): Rung => ({ width, height, fps, bitrate });
const SMOOTH = [rung(1920, 1080, 60, 8_000_000), rung(1280, 720, 60, 4_500_000), rung(1280, 720, 30, 2_500_000)];
const SHARP = [rung(1920, 1080, 30, 4_000_000), rung(1920, 1080, 15, 2_500_000)];
const SHARP_720 = [rung(1280, 720, 30, 2_000_000), rung(1280, 720, 15, 1_200_000)];
/** A software encoder next to a running game holds about 720p30 (or 1080p15): pixels per second it may be asked for. */
const SOFTWARE_PIXEL_RATE = 32_000_000;

/** The rungs a stream may use, best first. The first one is where it starts and what the capture is sized for. */
export function ladderFor(mode: ShareMode, cap720: boolean, encoder: EncoderKind): Rung[] {
  const all = mode === 'sharp' ? (cap720 ? SHARP_720 : SHARP) : cap720 ? SMOOTH.filter((r) => r.height <= 720) : SMOOTH;
  if (encoder === 'hardware') return all;
  const ok = all.filter((r) => r.width * r.height * r.fps <= SOFTWARE_PIXEL_RATE);
  return ok.length ? ok : [all[all.length - 1]];
}

export const rungLabel = (r: { height: number; fps: number }): string => `${r.height}p · ${r.fps}`;

/** Whether an outbound-rtp stat was encoded on the GPU; null when the browser does not say. */
export function encoderKindOf(stat: Record<string, unknown> | null | undefined): EncoderKind | null {
  if (!stat) return null;
  if (typeof stat['powerEfficientEncoder'] === 'boolean') return stat['powerEfficientEncoder'] ? 'hardware' : 'software';
  const impl = typeof stat['encoderImplementation'] === 'string' ? stat['encoderImplementation'] : '';
  if (/libvpx|openh264|libaom|svt|software/i.test(impl)) return 'software';
  if (/mediafoundation|videotoolbox|vaapi|nvenc|nvidia|d3d|external|accelerat/i.test(impl)) return 'hardware';
  return null;
}

// ---- rules (pure) -----------------------------------------------------------------------------

export type GovLimit = 'none' | 'cpu' | 'bandwidth' | 'other';
/** Why the stream is below what was asked for; 'ok' = it is not. */
export type GovReason = 'ok' | 'software' | 'capture' | 'cpu' | 'bandwidth';

/** One reading of the main layer, taken every SAMPLE_MS. */
export interface GovSample {
  /** False while nobody receives the main layer (the SFU switched it off): nothing can be judged. */
  active: boolean;
  /** Frames per second the screen capture delivers; null when unknown. */
  captureFps: number | null;
  limit: GovLimit;
  /** Encoder in use; null when unknown. */
  encoder: EncoderKind | null;
}

export interface GovConfig {
  /** The probe promised a hardware encoder: check that the browser really uses one. */
  expectHardware: boolean;
  /** Ladder to fall back to when it does not. */
  softwareLadder: Rung[];
}

export interface GovState {
  ladder: Rung[];
  /** Index into ladder; 0 is the best. */
  rung: number;
  /** Frame-rate cap below the rung's own, set while the capture cannot deliver more. */
  fpsCap: number | null;
  /** Multiplier on the rung's bitrate (below 1 after an upload limit). */
  bitrateScale: number;
  reason: GovReason;
  softwareLocked: boolean;
  /** Consecutive samples each condition has held. */
  software: number;
  capture: number;
  cpu: number;
  bandwidth: number;
  clean: number;
  /** No judging before this time: the encoder is still ramping after a start or a change. */
  settleUntil: number;
  /** Wait between steps up; doubles when a step up had to be taken back. */
  upWait: number;
  nextUpAt: number;
  lastUpAt: number | null;
}

export const SAMPLE_MS = 2000;
/** A condition must hold this many samples (6 s) before acting. */
const HOLD = 3;
/** Clean samples (30 s) before trying a step up. */
const CLEAN = 15;
const SETTLE_MS = 6000;
const START_SETTLE_MS = 10_000;
const UP_WAIT_MS = 30_000;
const UP_WAIT_MAX_MS = 300_000;
/** A step down this soon after a step up means the step up failed. */
const UP_FAILED_MS = 30_000;
/** Below this the screen is simply not changing (a still desktop), which says nothing about capture health. */
const IDLE_FPS = 15;

export function govInit(ladder: Rung[], now: number): GovState {
  return {
    ladder, rung: 0, fpsCap: null, bitrateScale: 1, reason: 'ok', softwareLocked: false,
    software: 0, capture: 0, cpu: 0, bandwidth: 0, clean: 0,
    settleUntil: now + START_SETTLE_MS, upWait: UP_WAIT_MS, nextUpAt: now, lastUpAt: null,
  };
}

/** What the main layer should send in this state. */
export function govTarget(s: GovState): Rung {
  const r = s.ladder[s.rung];
  const capped = s.fpsCap !== null && s.fpsCap < r.fps;
  // Half the frames need clearly less than the full bitrate, but more than half (each frame differs more).
  return { width: r.width, height: r.height, fps: capped ? s.fpsCap! : r.fps, bitrate: Math.round(r.bitrate * s.bitrateScale * (capped ? 0.7 : 1)) };
}

function stepped(s: GovState, now: number, patch: Partial<GovState>, down: boolean): GovState {
  const n: GovState = { ...s, ...patch, software: 0, capture: 0, cpu: 0, bandwidth: 0, clean: 0, settleUntil: now + SETTLE_MS };
  if (down) {
    if (s.lastUpAt !== null && now - s.lastUpAt < UP_FAILED_MS) n.upWait = Math.min(s.upWait * 2, UP_WAIT_MAX_MS);
    n.nextUpAt = now + n.upWait;
    n.lastUpAt = null;
  } else {
    n.lastUpAt = now;
    n.nextUpAt = now + n.upWait;
    if (n.rung === 0 && n.fpsCap === null && n.bitrateScale === 1) n.reason = n.softwareLocked ? 'software' : 'ok';
  }
  return n;
}

/** The governor's whole decision: previous state + one sample → next state. */
export function govStep(s: GovState, x: GovSample, now: number, cfg: GovConfig): GovState {
  if (!x.active) return { ...s, software: 0, capture: 0, cpu: 0, bandwidth: 0, clean: 0 };

  // The browser did not use the hardware encoder after all: this PC gets the software ladder for this stream.
  if (cfg.expectHardware && !s.softwareLocked) {
    const software = x.encoder === 'software' ? s.software + 1 : 0;
    if (software >= HOLD)
      return stepped(s, now, { ladder: cfg.softwareLadder, rung: 0, fpsCap: null, bitrateScale: 1, softwareLocked: true, reason: 'software' }, true);
    s = { ...s, software };
  }
  if (now < s.settleUntil) return s;

  const target = govTarget(s);
  const starved = x.limit === 'none' && x.captureFps !== null && target.fps > 30 && x.captureFps >= IDLE_FPS && x.captureFps < 0.75 * target.fps;
  const n: GovState = {
    ...s,
    capture: starved ? s.capture + 1 : 0,
    cpu: x.limit === 'cpu' ? s.cpu + 1 : 0,
    bandwidth: x.limit === 'bandwidth' ? s.bandwidth + 1 : 0,
    clean: x.limit === 'none' && !starved ? s.clean + 1 : 0,
  };
  const last = n.ladder.length - 1;

  if (n.cpu >= HOLD) {
    if (n.rung < last) return stepped(n, now, { rung: n.rung + 1, bitrateScale: 1, reason: 'cpu' }, true);
    return { ...n, cpu: 0, reason: 'cpu' };
  }
  if (n.bandwidth >= HOLD) {
    if (n.bitrateScale === 1) return stepped(n, now, { bitrateScale: 0.7, reason: 'bandwidth' }, true);
    if (n.rung < last) return stepped(n, now, { rung: n.rung + 1, bitrateScale: 1, reason: 'bandwidth' }, true);
    if (n.bitrateScale > 0.5) return stepped(n, now, { bitrateScale: 0.5, reason: 'bandwidth' }, true);
    return { ...n, bandwidth: 0 };
  }
  if (n.capture >= HOLD) return stepped(n, now, { fpsCap: 30, reason: 'capture' }, true);

  if (n.clean >= CLEAN && now >= n.nextUpAt) {
    // A step up that survived a minute is a success: the next one need not wait longer.
    if (n.lastUpAt !== null && now - n.lastUpAt > 2 * UP_FAILED_MS) n.upWait = UP_WAIT_MS;
    if (n.bitrateScale < 1) return stepped(n, now, { bitrateScale: 1 }, false);
    if (n.fpsCap !== null) return stepped(n, now, { fpsCap: null }, false);
    if (n.rung > 0) return stepped(n, now, { rung: n.rung - 1 }, false);
    n.clean = 0;
  }
  return n;
}

// ---- runtime ----------------------------------------------------------------------------------

/** What the streamer is told about their own stream. */
export interface ShareStatus {
  /** "720p · 60" */
  label: string;
  reason: GovReason;
}

type Stat = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Holds a screen share at a quality this PC and uplink can keep: reads the sender's stats every two seconds and moves
 * the main layer down or back up one deliberate step at a time (RTCRtpSender.setParameters: no renegotiation, no new
 * capture prompt). The lower simulcast layers are left alone.
 */
export class ShareGovernor {
  private state: GovState;
  private timer?: ReturnType<typeof setInterval>;
  private applied: string;
  private busy = false;
  private prevFrames: { frames: number; at: number } | null = null;

  constructor(
    private readonly track: LocalVideoTrack,
    ladder: Rung[],
    private readonly cfg: GovConfig,
    private readonly onStatus: (s: ShareStatus) => void,
  ) {
    this.state = govInit(ladder, performance.now());
    this.applied = JSON.stringify(govTarget(this.state));
  }

  start(): void {
    this.emit();
    this.timer = setInterval(() => void this.tick(), SAMPLE_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    this.onStatus({ label: rungLabel(govTarget(this.state)), reason: this.state.reason });
  }

  private async tick(): Promise<void> {
    const sender = this.track.sender;
    if (!sender || this.busy) return;
    this.busy = true;
    try {
      const encodings = sender.getParameters().encodings ?? [];
      const main = encodings[encodings.length - 1];
      if (!main) return;
      const report = await sender.getStats();
      const before = this.state;
      this.state = govStep(before, this.sample(report, main), performance.now(), this.cfg);
      if (this.state.reason !== before.reason) this.emit();
      await this.apply();
    } catch {
      /* the track went away mid-read; stop() follows */
    } finally {
      this.busy = false;
    }
  }

  private sample(report: RTCStatsReport, main: RTCRtpEncodingParameters): GovSample {
    let out: Stat | null = null;
    let source: Stat | null = null;
    report.forEach((r: Stat) => {
      if (r['type'] === 'outbound-rtp' && r['kind'] === 'video' && (!main.rid || r['rid'] === main.rid)) out = r;
      else if (r['type'] === 'media-source' && r['kind'] === 'video') source = r;
    });
    const o = out as Stat | null;
    const src = source as Stat | null;
    let captureFps: number | null = typeof src?.['framesPerSecond'] === 'number' ? src['framesPerSecond'] : null;
    if (captureFps === null && typeof src?.['frames'] === 'number') {
      const now = performance.now();
      if (this.prevFrames) captureFps = ((src['frames'] - this.prevFrames.frames) * 1000) / Math.max(1, now - this.prevFrames.at);
      this.prevFrames = { frames: src['frames'], at: now };
    }
    const why = o?.['qualityLimitationReason'];
    return {
      active: main.active !== false && !!o,
      captureFps,
      limit: why === 'cpu' || why === 'bandwidth' || why === 'other' ? why : 'none',
      encoder: encoderKindOf(o),
    };
  }

  /** Writes the target to the main encoding when it differs from what was last written. */
  private async apply(): Promise<void> {
    const target = govTarget(this.state);
    const key = JSON.stringify(target);
    const sender = this.track.sender;
    if (key === this.applied || !sender) return;
    const params = sender.getParameters();
    const main = params.encodings?.[params.encodings.length - 1];
    if (!main) return;
    const got = this.track.mediaStreamTrack.getSettings();
    const scale = Math.max(1, (got.width ?? target.width) / target.width, (got.height ?? target.height) / target.height);
    main.maxFramerate = target.fps;
    main.maxBitrate = target.bitrate;
    main.scaleResolutionDownBy = scale;
    await sender.setParameters(params);
    this.applied = key;
    this.emit();
  }
}
