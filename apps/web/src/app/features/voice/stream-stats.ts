import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { encoderKindOf } from '../../core/media/share-governor';
import { Icon } from '../../shared/ui/icon';

const OPEN_KEY = 'hangar.streamStats';

/** Whether the live stats panel is open (one choice for every stream, remembered on this device). */
export const streamStatsOpen = signal(loadOpen());

export function setStreamStatsOpen(open: boolean): void {
  streamStatsOpen.set(open);
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Live network/decoder numbers of one stream, from WebRTC getStats (one second apart). */
export interface NetStats {
  /** Watching someone: what arrives. Own stream: what is sent (all simulcast layers together). */
  direction: 'in' | 'out';
  mbps: number;
  codec: string | null;
  rttMs: number | null;
  /** How the media travels: "UDP direct", "TCP direct", "Relay (TLS)"… Direct UDP is the only smooth one at high bitrates. */
  transport: string | null;
  // Receiving
  lossPct?: number;
  jitterMs?: number;
  droppedFrames?: number;
  decodeMs?: number | null;
  freezes?: number;
  // Sending
  layers?: string[];
  /** The browser's qualityLimitationReason: none, cpu, bandwidth or other. */
  limitedBy?: string;
  /** "Hardware (MediaFoundation…)" / "Software (libvpx)": where the main layer is encoded. */
  encoder?: string | null;
}

type Stat = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Turns two getStats reports (previous may be null) into the panel's numbers. */
export class NetStatsReader {
  private prev = new Map<string, Stat>();
  private prevAt = 0;

  read(report: RTCStatsReport, direction: 'in' | 'out'): NetStats | null {
    const now = performance.now();
    const dt = this.prevAt ? (now - this.prevAt) / 1000 : 0;
    let inbound: Stat | null = null;
    let pair: Stat | null = null;
    let selectedPairId: string | null = null;
    const outbound: Stat[] = [];
    const codecs = new Map<string, Stat>();
    const byId = new Map<string, Stat>();
    report.forEach((r: Stat) => {
      byId.set(r['id'], r);
      if (r['type'] === 'transport' && r['selectedCandidatePairId']) selectedPairId = r['selectedCandidatePairId'];
      if (r['type'] === 'inbound-rtp' && r['kind'] === 'video') inbound = r;
      else if (r['type'] === 'outbound-rtp' && r['kind'] === 'video') outbound.push(r);
      else if (r['type'] === 'codec') codecs.set(r['id'], r);
      else if (r['type'] === 'candidate-pair' && r['state'] === 'succeeded' && (r['nominated'] || r['selected'] || !pair)) pair = r;
    });
    if (selectedPairId && byId.has(selectedPairId)) pair = byId.get(selectedPairId)!;
    const transport = transportText(byId.get((pair as Stat | null)?.['localCandidateId']));
    const rtt = (pair as Stat | null)?.['currentRoundTripTime'];
    const rttMs = typeof rtt === 'number' ? Math.round(rtt * 1000) : null;
    const codecOf = (r: Stat | null) => {
      const mime = r ? codecs.get(r['codecId'])?.['mimeType'] : null;
      return typeof mime === 'string' ? mime.replace(/^video\//i, '') : null;
    };
    const delta = (r: Stat, key: string) => {
      const p = this.prev.get(r['id']);
      return p && typeof r[key] === 'number' && typeof p[key] === 'number' ? Math.max(0, r[key] - p[key]) : 0;
    };

    let out: NetStats | null = null;
    // The first report only sets the baseline: rates need two samples.
    if (!dt) {
      /* measuring… */
    } else if (direction === 'in' && inbound) {
      const r = inbound as Stat;
      const lost = delta(r, 'packetsLost');
      const got = delta(r, 'packetsReceived');
      const decoded = delta(r, 'framesDecoded');
      out = {
        direction, rttMs, transport, codec: codecOf(r),
        mbps: (delta(r, 'bytesReceived') * 8) / dt / 1e6,
        lossPct: lost + got > 0 ? (lost / (lost + got)) * 100 : 0,
        jitterMs: typeof r['jitter'] === 'number' ? Math.round(r['jitter'] * 1000) : undefined,
        droppedFrames: r['framesDropped'] ?? 0,
        decodeMs: decoded ? (delta(r, 'totalDecodeTime') / decoded) * 1000 : null,
        freezes: r['freezeCount'] ?? 0,
      };
    } else if (direction === 'out' && outbound.length) {
      const active = outbound.filter((r) => r['frameHeight']).sort((a, b) => (b['frameHeight'] ?? 0) - (a['frameHeight'] ?? 0));
      out = {
        direction, rttMs, transport, codec: codecOf(active[0] ?? outbound[0]), encoder: encoderText(active[0]),
        mbps: (outbound.reduce((sum, r) => sum + delta(r, 'bytesSent'), 0) * 8) / dt / 1e6,
        layers: active.map((r) => `${r['frameHeight']}p${r['framesPerSecond'] ? ' ' + Math.round(r['framesPerSecond']) : ''}`),
        limitedBy: active[0]?.['qualityLimitationReason'] ?? 'none',
      };
    }
    this.prev.clear();
    report.forEach((r: Stat) => {
      if (r['type'] === 'inbound-rtp' || r['type'] === 'outbound-rtp') this.prev.set(r['id'], r);
    });
    this.prevAt = now;
    return out;
  }

  reset(): void {
    this.prev.clear();
    this.prevAt = 0;
  }
}

/** The selected local ICE candidate in words. Anything but direct UDP means stutter at screen-share bitrates. */
function transportText(local: Stat | undefined): string | null {
  if (!local) return null;
  if (local['candidateType'] === 'relay') return `Relay (${String(local['relayProtocol'] ?? 'udp').toUpperCase()})`;
  return `${String(local['protocol'] ?? 'udp').toUpperCase()} direct`;
}

function encoderText(top: Stat | undefined): string | null {
  const kind = encoderKindOf(top);
  const impl = typeof top?.['encoderImplementation'] === 'string' ? top['encoderImplementation'] : '';
  if (!kind) return impl || null;
  return `${kind === 'hardware' ? 'Hardware' : 'Software'}${impl ? ` (${impl})` : ''}`;
}

/** The small "stats for nerds" panel under a stream's top bar; numbers refresh every second while it is open. */
@Component({
  selector: 'hx-stream-stats',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sstats mono" role="status" aria-live="off" data-testid="stream-stats-panel">
      <button class="sstats-x" aria-label="Close stream stats" (click)="close()"><hx-icon name="x" size="sm" /></button>
      @if (view(); as v) {
        <div><span>Showing</span>{{ v.width }}×{{ v.height }} · {{ v.fps }} fps</div>
      }
      @if (net(); as n) {
        @if (n.direction === 'in') {
          <div><span>Bitrate</span>{{ mbps(n.mbps) }}</div>
          <div [class.bad]="(n.lossPct ?? 0) >= 2"><span>Packet loss</span>{{ (n.lossPct ?? 0).toFixed(1) }}%</div>
          <div><span>Ping</span>{{ n.rttMs ?? '—' }} ms@if (n.jitterMs !== undefined) { · jitter {{ n.jitterMs }} ms }</div>
          <div><span>Dropped</span>{{ n.droppedFrames }} frames@if (n.freezes) { · {{ n.freezes }} freezes }</div>
          @if (n.decodeMs !== null && n.decodeMs !== undefined) { <div><span>Decode</span>{{ n.decodeMs.toFixed(1) }} ms/frame</div> }
        } @else {
          <div><span>Sending</span>{{ n.layers?.join(' / ') || '—' }}</div>
          <div><span>Bitrate</span>{{ mbps(n.mbps) }}</div>
          <div [class.bad]="n.limitedBy && n.limitedBy !== 'none'"><span>Limited by</span>{{ limitText(n.limitedBy) }}</div>
          <div><span>Ping</span>{{ n.rttMs ?? '—' }} ms</div>
          @if (n.encoder) { <div [class.bad]="n.encoder.startsWith('Software')"><span>Encoder</span>{{ n.encoder }}</div> }
        }
        @if (n.codec) { <div><span>Codec</span>{{ n.codec }}</div> }
        @if (n.transport) { <div [class.bad]="n.transport !== 'UDP direct'"><span>Transport</span>{{ n.transport }}</div> }
      } @else {
        <div><span>Network</span>measuring…</div>
      }
    </div>
  `,
})
export class StreamStatsPanel {
  readonly view = input<{ width: number; height: number; fps: number } | null>(null);
  readonly net = input<NetStats | null>(null);

  close(): void {
    setStreamStatsOpen(false);
  }

  mbps(v: number): string {
    return v >= 1 ? `${v.toFixed(1)} Mbps` : `${Math.round(v * 1000)} kbps`;
  }

  limitText(r: string | undefined): string {
    return r === 'cpu' ? 'CPU (encoder too slow)' : r === 'bandwidth' ? 'Upload bandwidth' : r && r !== 'none' ? r : 'Nothing';
  }
}
