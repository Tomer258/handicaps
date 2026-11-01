import { GtcrnWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';

/** RNNoise and GTCRN models + worklets, copied from @sapphi-red/web-noise-suppressor by angular.json (assets → /noise). */
const ASSETS = '/noise/';
/** RNNoise works on 48 kHz frames only (GTCRN takes 48 kHz too); the graph resamples the microphone into it. */
const SAMPLE_RATE = 48000;
export const MIC_PROCESSOR = 'hangar-mic';

/**
 * enhanced = RNNoise · strong = RNNoise, then GTCRN. Measured with tests/e2e/scripts/noise-bench.mjs: RNNoise removes
 * steady noise (fan -36 dB) but barely touches keyboard clicks (-6 dB); GTCRN is the other way round (fan -11 dB,
 * clicks -30 dB); the chain removes both (fan -56 dB, clicks -38 dB) and leaves speech unchanged.
 */
export type NeuralFilter = 'enhanced' | 'strong';

let model: Promise<ArrayBuffer> | undefined;
let gtcrnModel: Promise<ArrayBuffer> | undefined;

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

/** The GTCRN model, fetched and compiled once (same reasoning as loadNoiseModel). */
export function loadGtcrnModel(): Promise<ArrayBuffer> {
  gtcrnModel ??= loadGtcrn({ url: ASSETS + 'gtcrn.wasm' })
    .then(async (bin) => {
      await WebAssembly.compile(bin);
      return bin;
    })
    .catch((e: unknown) => {
      gtcrnModel = undefined;
      throw e;
    });
  return gtcrnModel;
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

/** A chain of mono model nodes in `ctx`: connect into `input`, out of `output`; destroy() frees the wasm state. */
export interface NoiseFilterChain {
  input: AudioNode;
  output: AudioNode;
  destroy(): void;
}

/** The filter chain for `kind` in `ctx`. Throws (after cleaning up) when a model or worklet cannot load. */
export async function createNoiseFilter(ctx: AudioContext, kind: NeuralFilter): Promise<NoiseFilterChain> {
  const nodes: (RnnoiseWorkletNode | GtcrnWorkletNode)[] = [];
  const destroy = () => nodes.forEach((n) => {
    n.destroy();
    n.disconnect();
  });
  try {
    const rnnoiseBin = await loadNoiseModel();
    await ctx.audioWorklet.addModule(ASSETS + 'rnnoise/workletProcessor.js');
    nodes.push(new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: rnnoiseBin }));
    if (kind === 'strong') {
      const gtcrnBin = await loadGtcrnModel();
      await ctx.audioWorklet.addModule(ASSETS + 'gtcrn/workletProcessor.js');
      nodes.push(new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: gtcrnBin }));
    }
  } catch (e) {
    destroy();
    throw e;
  }
  for (const node of nodes) {
    // Mix any stereo input down to one channel: the models only process the first channel, so a stereo mic would
    // come out with the right side silent. The mono output then plays in both ears.
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
  }
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  return { input: nodes[0], output: nodes[nodes.length - 1], destroy };
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
 * LiveKit audio processor: microphone → [RNNoise [→ GTCRN]] → gate → published track, in its own 48 kHz context
 * (the room's context runs at the device rate). init() throws when it cannot start, so the caller can
 * fall back (browser suppression, open mic); later failures (rebuild on device switch, a crash in a
 * worklet) are reported through `onFail`. The gate is changed live with setGate()/setPtt().
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = MIC_PROCESSOR;
  processedTrack?: MediaStreamTrack;
  private ctx?: AudioContext;
  private chain?: NoiseFilterChain;
  private gateNode?: AudioWorkletNode;
  private pttDown = false;

  constructor(
    /** null = gate only. */
    readonly filter: NeuralFilter | null,
    private gate: GateConfig,
    private readonly onFail: (filter: boolean) => void,
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
      setTimeout(() => this.onFail(!!this.filter));
    }
  }

  async destroy(): Promise<void> {
    this.chain?.destroy();
    this.chain = undefined;
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
      let chain: NoiseFilterChain | undefined;
      if (this.filter) {
        chain = await createNoiseFilter(ctx, this.filter);
        for (const n of [chain.input, chain.output]) (n as AudioWorkletNode).onprocessorerror = () => this.onFail(true);
      }
      const gate = await createMicGate(ctx);
      gate.onprocessorerror = () => this.onFail(!!this.filter);
      gate.port.postMessage({ ...this.gate, pttDown: this.pttDown });
      const out = ctx.createMediaStreamDestination();
      out.channelCount = 1;
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      if (chain) {
        src.connect(chain.input);
        chain.output.connect(gate);
      } else src.connect(gate);
      gate.connect(out);
      this.ctx = ctx;
      this.chain = chain;
      this.gateNode = gate;
      this.processedTrack = out.stream.getAudioTracks()[0];
    } catch (e) {
      void ctx.close().catch(() => undefined);
      throw e;
    }
  }
}
