import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';

/** RNNoise model + worklet, copied from @sapphi-red/web-noise-suppressor by angular.json (assets → /noise). */
const ASSETS = '/noise/';
/** RNNoise works on 48 kHz frames only; the graph resamples the microphone into it. */
const SAMPLE_RATE = 48000;
export const MIC_PROCESSOR = 'hangar-mic';

let model: Promise<ArrayBuffer> | undefined;

/**
 * Fetches the RNNoise model once and compiles it here first: the worklet compiles it asynchronously,
 * where a failure (CSP without 'wasm-unsafe-eval', a missing file) would only show up as a silent mic.
 */
export function loadNoiseModel(): Promise<ArrayBuffer> {
  model ??= loadRnnoise({ url: ASSETS + 'rnnoise.wasm', simdUrl: ASSETS + 'rnnoise_simd.wasm' })
    .then(async (bin) => {
      await WebAssembly.compile(bin);
      return bin;
    })
    .catch((e: unknown) => {
      model = undefined;
      throw e;
    });
  return model;
}

/** An AudioContext RNNoise (and the gate) can run in, running (a suspended context would send silence). */
export async function noiseContext(): Promise<AudioContext> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
  if (ctx.state !== 'running') {
    void ctx.close().catch(() => undefined);
    throw new Error('audio context suspended');
  }
  return ctx;
}

/** A mono RNNoise node in `ctx`. Call destroy() on it when done (frees the wasm state in the worklet). */
export async function createNoiseFilter(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  const wasmBinary = await loadNoiseModel();
  await ctx.audioWorklet.addModule(ASSETS + 'rnnoise/workletProcessor.js');
  const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  // Mix any stereo input down to one channel: RNNoise only processes the first channel, so a stereo mic would
  // come out with the right side silent. The mono output then plays in both ears.
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers';
  return node;
}

export type GateMode = 'open' | 'vad' | 'ptt';

export interface GateConfig {
  /** open = always sending · vad = only above `thresholdDb` · ptt = only while the key is held. */
  mode: GateMode;
  thresholdDb: number;
  releaseMs: number;
}

/** Push to talk / input sensitivity gate (public/audio/mic-gate.js) in `ctx`, mono. */
export async function createMicGate(ctx: BaseAudioContext): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule('/audio/mic-gate.js');
  return new AudioWorkletNode(ctx, 'hangar-mic-gate', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
  });
}

/**
 * LiveKit audio processor: microphone → [RNNoise] → gate → published track, in its own 48 kHz context
 * (the room's context runs at the device rate). init() throws when it cannot start, so the caller can
 * fall back (browser suppression, open mic); later failures (rebuild on device switch, a crash in a
 * worklet) are reported through `onFail`. The gate is changed live with setGate()/setPtt().
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = MIC_PROCESSOR;
  processedTrack?: MediaStreamTrack;
  private ctx?: AudioContext;
  private node?: RnnoiseWorkletNode;
  private gateNode?: AudioWorkletNode;
  private pttDown = false;

  constructor(
    readonly rnnoise: boolean,
    private gate: GateConfig,
    private readonly onFail: (rnnoise: boolean) => void,
  ) {}

  init(opts: AudioProcessorOptions): Promise<void> {
    return this.build(opts.track);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    try {
      await this.build(opts.track);
    } catch {
      // Called under LiveKit's track lock: report after it is released.
      setTimeout(() => this.onFail(this.rnnoise));
    }
  }

  async destroy(): Promise<void> {
    this.node?.destroy();
    this.node?.disconnect();
    this.node = undefined;
    this.gateNode?.disconnect();
    this.gateNode = undefined;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    const ctx = this.ctx;
    this.ctx = undefined;
    await ctx?.close().catch(() => undefined);
  }

  setGate(gate: GateConfig): void {
    this.gate = gate;
    this.gateNode?.port.postMessage({ ...gate });
  }

  setPtt(down: boolean): void {
    this.pttDown = down;
    this.gateNode?.port.postMessage({ pttDown: down });
  }

  private async build(track: MediaStreamTrack): Promise<void> {
    const ctx = await noiseContext();
    try {
      let node: RnnoiseWorkletNode | undefined;
      if (this.rnnoise) {
        node = await createNoiseFilter(ctx);
        node.onprocessorerror = () => this.onFail(true);
      }
      const gate = await createMicGate(ctx);
      gate.onprocessorerror = () => this.onFail(this.rnnoise);
      gate.port.postMessage({ ...this.gate, pttDown: this.pttDown });
      const out = ctx.createMediaStreamDestination();
      out.channelCount = 1;
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      (node ? src.connect(node) : src).connect(gate).connect(out);
      this.ctx = ctx;
      this.node = node;
      this.gateNode = gate;
      this.processedTrack = out.stream.getAudioTracks()[0];
    } catch (e) {
      void ctx.close().catch(() => undefined);
      throw e;
    }
  }
}
