import { isDevMode, signal } from '@angular/core';
import type { EncoderKind } from './share-governor';

/** What this PC should publish a screen share with. */
export interface EncodeProbe {
  codec: 'h264' | 'vp8';
  encoder: EncoderKind;
}

/** Dev builds only: localStorage 'hangar.forceEncoder' = 'hardware' | 'software' overrides the probe (smokes). */
const FORCE_KEY = 'hangar.forceEncoder';
const SIZES: [number, number, number, number][] = [[1920, 1080, 60, 8_000_000], [1280, 720, 60, 4_500_000], [1280, 720, 30, 2_500_000]];

const result = signal<EncodeProbe | null>(null);
/** The probe's answer once it is known (null while it runs). Read synchronously inside the Go Live click. */
export const encodeProbe = result.asReadonly();

let running: Promise<EncodeProbe> | undefined;

/**
 * Asks the browser whether it can encode H.264 on the GPU (NVENC / Quick Sync / AMF). That encoder is a separate chip
 * from the one drawing the game, so it holds 1080p60; a software encoder shares the CPU with the game and does not.
 * Without one the stream uses VP8 in software at a size it can keep. Runs once per page.
 */
export function probeEncoder(): Promise<EncodeProbe> {
  return (running ??= run().then((p) => {
    result.set(p);
    return p;
  }));
}

async function run(): Promise<EncodeProbe> {
  const h264 = canSendH264();
  const forced = forcedEncoder();
  if (forced) return { codec: forced === 'hardware' && h264 ? 'h264' : 'vp8', encoder: forced };
  if (!h264 || !navigator.mediaCapabilities?.encodingInfo) return { codec: 'vp8', encoder: 'software' };
  for (const contentType of h264ContentTypes()) {
    for (const [width, height, framerate, bitrate] of SIZES) {
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType, width, height, framerate, bitrate } });
        if (info.supported && info.powerEfficient) return { codec: 'h264', encoder: 'hardware' };
      } catch {
        /* this profile or size is not answerable; try the next */
      }
    }
  }
  return { codec: 'vp8', encoder: 'software' };
}

let preferHigh = false;
let patched = false;

/**
 * While on, the H.264 codec the SFU picks in its SDP answers is presented to the browser as High profile, level 5.
 *
 * Why: the browser encodes with the first codec of the answer, and LiveKit 1.9 answers (and offers to viewers) only
 * Constrained Baseline, level 3.1. On Windows the GPU encoders (NVENC / Quick Sync / AMF) are used for High profile
 * only — Baseline falls to OpenH264 in software, which cannot do 1080p60 — and level 3.1 stops at 720p30. With the
 * profile rewritten the browser sends High profile under the payload type the SFU chose; the SFU forwards packets
 * without caring about the profile, and every desktop Chrome/Edge decodes High whatever the SDP said.
 * livekit-client has no option for this, so the answer is rewritten where it enters the browser. Only sections whose
 * first codec is H.264 are touched (cameras publish VP8). Kept on for the whole share, because later renegotiations
 * carry the same Baseline answer again.
 */
export function preferHighProfileH264(on: boolean): void {
  preferHigh = on;
  if (!on || patched || typeof RTCPeerConnection === 'undefined') return;
  patched = true;
  const native = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
    const desc = args[0] as RTCSessionDescriptionInit | undefined;
    // Only when this browser offered High profile itself: then it has an encoder for it.
    if (preferHigh && desc?.type === 'answer' && desc.sdp && /profile-level-id=64/i.test(this.localDescription?.sdp ?? ''))
      args[0] = { type: desc.type, sdp: asHighProfile(desc.sdp) };
    return (native as (...a: unknown[]) => Promise<void>).apply(this, args);
  } as typeof native;
}

/** High profile, level 5.0: what Chrome's hardware encoders advertise; covers 1080p60 (needs 4.2). */
const HIGH_PROFILE = '640032';

/**
 * Where the bandwidth estimate starts, kbps. The browser's own default (300) left viewers on the 360p layer for the
 * first 12 s of every share; livekit-client's hint sits on a payload type the SFU does not pick. 4 Mbps carries the
 * 720p layer at once and reaches the main one within seconds, without flooding a small uplink.
 */
const START_KBPS = 4000;

/** Exported for the unit test. */
export function asHighProfile(sdp: string): string {
  const lines = sdp.split('\r\n');
  let start = -1;
  const rewrite = (from: number, to: number) => {
    const m = /^m=video \S+ \S+ (.+)$/.exec(lines[from]);
    if (!m) return;
    const first = m[1].split(' ')[0];
    let isH264 = false;
    let fmtp = -1;
    for (let i = from + 1; i < to; i++) {
      if (new RegExp(`^a=rtpmap:${first} H264/`, 'i').test(lines[i])) isH264 = true;
      if (lines[i].startsWith(`a=fmtp:${first} `)) fmtp = i;
    }
    if (!isH264 || fmtp < 0) return;
    lines[fmtp] = lines[fmtp].replace(/profile-level-id=[0-9a-f]{6}/i, `profile-level-id=${HIGH_PROFILE}`);
    if (!/x-google-start-bitrate/.test(lines[fmtp])) lines[fmtp] += `;x-google-start-bitrate=${START_KBPS}`;
  };
  for (let i = 0; i <= lines.length; i++) {
    if (i === lines.length || lines[i].startsWith('m=')) {
      if (start >= 0) rewrite(start, i);
      start = i;
    }
  }
  return lines.join('\r\n');
}

const isH264 = (c: { mimeType: string }) => c.mimeType.toLowerCase() === 'video/h264';

/** The contentType strings to ask mediaCapabilities about: one per H.264 profile this browser can send. */
function h264ContentTypes(): string[] {
  try {
    const lines = RTCRtpSender.getCapabilities('video')?.codecs.filter(isH264).map((c) => c.sdpFmtpLine).filter((l): l is string => !!l) ?? [];
    // High profile first: it is the one GPU encoders implement.
    const sorted = [...new Set(lines)].sort((a, b) => +/profile-level-id=64/i.test(b) - +/profile-level-id=64/i.test(a));
    return [...sorted.map((l) => `video/H264;${l}`), 'video/H264'];
  } catch {
    return ['video/H264'];
  }
}

function canSendH264(): boolean {
  try {
    return !!RTCRtpSender.getCapabilities?.('video')?.codecs.some((c) => c.mimeType.toLowerCase() === 'video/h264');
  } catch {
    return false;
  }
}

function forcedEncoder(): EncoderKind | null {
  if (!isDevMode()) return null;
  try {
    const v = localStorage.getItem(FORCE_KEY);
    return v === 'hardware' || v === 'software' ? v : null;
  } catch {
    return null;
  }
}
