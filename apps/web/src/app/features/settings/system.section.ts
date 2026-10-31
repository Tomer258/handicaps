import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { WorkspaceStore } from '../workspaces/workspace.store';

interface ServiceUsage { name: string; cpuPercent: number; memoryMb: number; memoryLimitMb: number | null }
interface Point { at: string; apiCpu: number; apiMemoryMb: number; hostCpu: number | null; hostMemoryUsedMb: number | null; projectCpu: number; projectMemoryMb: number }
export interface SystemSnapshot {
  at: string;
  sampleSeconds: number;
  projectScope: 'services' | 'api';
  projectCpu: number;
  projectMemoryMb: number;
  api: { cpuPercent: number; memoryMb: number; managedHeapMb: number; threads: number; uptimeSeconds: number; runtime: string };
  host: { os: string; cores: number; cpuPercent: number | null; memoryTotalMb: number | null; memoryUsedMb: number | null };
  services: ServiceUsage[];
  disk: { path: string; totalGb: number; freeGb: number; filesMb: number | null; filesMeasuredAt: string | null } | null;
  database: { sizeMb: number; largest: { name: string; sizeMb: number }[] } | null;
  live: { onlineUsers: number; connections: number; inVoice: number; screens: number; cameras: number };
  history: Point[];
}

const NICE: Record<string, string> = {
  api: 'API', postgres: 'Database (Postgres)', livekit: 'Voice & video (LiveKit)', edge: 'Web server (Caddy)',
  'sound-publisher': 'Soundboard player', 'asset-validator': 'Upload checker', 'ops-monitor': 'Ops monitor',
  'auth-watchdog': 'Voice watchdog', backup: 'Backup', migrate: 'Database migration',
};

export function mb(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 1024 ? `${(v / 1024).toFixed(v >= 10240 ? 0 : 1)} GB` : `${v >= 100 ? Math.round(v) : v.toFixed(1)} MB`;
}
export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}
function duration(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** Polyline points for a 300×64 sparkline; null values break nothing (skipped). */
function line(values: (number | null)[], max: number): string {
  const n = values.length;
  if (n < 2 || max <= 0) return '';
  return values
    .map((v, i) => (v == null ? null : `${((i / (n - 1)) * 300).toFixed(1)},${(62 - (Math.min(v, max) / max) * 58).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
}

/** Administrator: how much Hangar takes on the machine — CPU, memory, per service, database, disk, live usage. */
@Component({
  selector: 'hx-system-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); gap: 10px; }
    .stat { padding: 14px 16px; border-radius: 14px; background: var(--bg2); border: 1px solid var(--line); min-width: 0; }
    .stat .k { font-size: 11.5px; color: var(--tx3); text-transform: uppercase; letter-spacing: .06em; }
    .stat .v { font-size: 24px; font-weight: 700; margin-top: 4px; white-space: nowrap; }
    .stat .s { font-size: 12px; color: var(--tx3); margin-top: 2px; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-top: 10px; }
    .chart svg { width: 100%; height: 64px; display: block; margin-top: 8px; }
    .legend { display: flex; gap: 12px; font-size: 11.5px; color: var(--tx3); }
    .legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th { text-align: left; font-weight: 500; font-size: 11.5px; color: var(--tx3); text-transform: uppercase; letter-spacing: .06em; padding: 0 8px 8px; }
    td { padding: 9px 8px; border-top: 1px solid var(--line); vertical-align: middle; }
    .bar { height: 6px; border-radius: 3px; background: var(--bg3); overflow: hidden; min-width: 60px; }
    .bar > span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
    .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13.5px; }
    .kv dt { color: var(--tx3); }
    .kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-top: 10px; }
  `,
  template: `
    <div style="display: flex; align-items: baseline; gap: 12px; margin: 0 0 6px; flex-wrap: wrap">
      <h2 class="disp" style="margin: 0; font-size: 26px; flex: 1">System</h2>
      @if (snap(); as s) {
        <span role="status" style="font-size: 12px; color: var(--tx3)"><span class="dot" style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--online); margin-right: 6px"></span>Live · every {{ s.sampleSeconds }} s</span>
      }
    </div>
    <p style="margin: 0 0 18px; color: var(--tx2); font-size: 13.5px">How much Hangar takes on this machine. CPU is a share of the whole machine ({{ snap()?.host?.cores ?? '…' }} cores = 100%).</p>

    @if (error(); as e) {
      <div class="card" role="alert" style="color: var(--danger)">{{ e }}</div>
    } @else if (!snap()) {
      <div class="card" style="color: var(--tx3)">Measuring…</div>
    } @else {
      @let s = snap()!;
      <div class="stats">
        <div class="stat" data-testid="project-cpu"><div class="k">Hangar CPU</div><div class="v">{{ pct(s.projectCpu) }}</div><div class="s">host total {{ pct(s.host.cpuPercent) }}</div></div>
        <div class="stat" data-testid="project-memory"><div class="k">Hangar memory</div><div class="v">{{ mb(s.projectMemoryMb) }}</div>
          <div class="s">{{ s.host.memoryTotalMb ? pct((s.projectMemoryMb / s.host.memoryTotalMb) * 100) + ' of ' + mb(s.host.memoryTotalMb) : '' }}</div></div>
        <div class="stat"><div class="k">Machine memory</div><div class="v">{{ s.host.memoryTotalMb ? pct(((s.host.memoryUsedMb ?? 0) / s.host.memoryTotalMb) * 100) : '—' }}</div>
          <div class="s">{{ mb(s.host.memoryUsedMb) }} used by everything</div></div>
        @if (s.disk; as d) {
          <div class="stat"><div class="k">Disk free</div><div class="v">{{ d.freeGb }} GB</div><div class="s">of {{ d.totalGb }} GB · files {{ mb(d.filesMb) }}</div></div>
        }
        @if (s.database; as db) {
          <div class="stat"><div class="k">Database</div><div class="v">{{ mb(db.sizeMb) }}</div><div class="s">on disk</div></div>
        }
      </div>

      <div class="charts">
        <div class="card chart" aria-label="CPU over the last hour">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
            <b style="font-size: 13.5px">CPU · last {{ span() }}</b>
            <span class="legend"><span><i style="background: var(--accent)"></i>Hangar</span><span><i style="background: var(--tx3)"></i>Machine</span></span>
          </div>
          <svg viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
            <polyline [attr.points]="cpuHost()" fill="none" stroke="var(--tx3)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
            <polyline [attr.points]="cpuProject()" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="legend" style="justify-content: space-between"><span>0%</span><span>{{ cpuMax() }}%</span></div>
        </div>
        <div class="card chart" aria-label="Memory over the last hour">
          <div style="display: flex; justify-content: space-between; align-items: center"><b style="font-size: 13.5px">Hangar memory · last {{ span() }}</b>
            <span class="legend">peak {{ mb(memPeak()) }}</span></div>
          <svg viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
            <polyline [attr.points]="memProject()" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="legend" style="justify-content: space-between"><span>0</span><span>{{ mb(memMax()) }}</span></div>
        </div>
      </div>

      <div class="lbl" style="margin: 26px 0 8px">By service</div>
      <div class="card" style="padding: 14px 8px 6px">
        <table aria-label="Usage by service">
          <thead><tr><th>Service</th><th class="num">CPU</th><th style="width: 34%">Memory</th><th class="num"></th></tr></thead>
          <tbody>
            @for (x of services(); track x.name) {
              <tr [attr.data-service]="x.name">
                <td>{{ nice(x.name) }}</td>
                <td class="num">{{ pct(x.cpuPercent) }}</td>
                <td><div class="bar"><span [style.width.%]="(x.memoryMb / memScale()) * 100"></span></div></td>
                <td class="num">{{ mb(x.memoryMb) }}@if (x.memoryLimitMb) {<span style="color: var(--tx3)"> / {{ mb(x.memoryLimitMb) }}</span>}</td>
              </tr>
            }
          </tbody>
        </table>
        @if (s.projectScope === 'api') {
          <p style="margin: 10px 8px 4px; font-size: 12.5px; color: var(--tx3)">
            Only the API process is measured here. On the server install the ops monitor adds the database, voice server, web server and workers.
          </p>
        }
      </div>

      <div class="two">
        <div class="card">
          <div class="lbl" style="margin: 0 0 10px">Right now</div>
          <dl class="kv" style="margin: 0">
            <dt>People online</dt><dd>{{ s.live.onlineUsers }}</dd>
            <dt>Open tabs (connections)</dt><dd>{{ s.live.connections }}</dd>
            <dt>In voice</dt><dd>{{ s.live.inVoice }}</dd>
            <dt>Screens shared</dt><dd>{{ s.live.screens }}</dd>
            <dt>Cameras on</dt><dd>{{ s.live.cameras }}</dd>
          </dl>
        </div>
        <div class="card">
          <div class="lbl" style="margin: 0 0 10px">API process</div>
          <dl class="kv" style="margin: 0">
            <dt>Memory</dt><dd>{{ mb(s.api.memoryMb) }}</dd>
            <dt>Managed heap</dt><dd>{{ mb(s.api.managedHeapMb) }}</dd>
            <dt>Threads</dt><dd>{{ s.api.threads }}</dd>
            <dt>Running for</dt><dd>{{ duration(s.api.uptimeSeconds) }}</dd>
            <dt>Runtime</dt><dd>{{ s.api.runtime }}</dd>
          </dl>
        </div>
        @if (s.database; as db) {
          <div class="card">
            <div class="lbl" style="margin: 0 0 10px">Largest tables</div>
            <dl class="kv" style="margin: 0">
              @for (t of db.largest; track t.name) { <dt class="mono" style="font-size: 12.5px">{{ t.name }}</dt><dd>{{ mb(t.sizeMb) }}</dd> }
            </dl>
          </div>
        }
        <div class="card">
          <div class="lbl" style="margin: 0 0 10px">Machine</div>
          <dl class="kv" style="margin: 0">
            <dt>System</dt><dd style="overflow-wrap: anywhere">{{ s.host.os }}</dd>
            <dt>Cores</dt><dd>{{ s.host.cores }}</dd>
            <dt>Memory</dt><dd>{{ mb(s.host.memoryTotalMb) }}</dd>
            @if (s.disk; as d) { <dt>Files folder</dt><dd class="mono" style="font-size: 11.5px; overflow-wrap: anywhere">{{ d.path }}</dd> }
          </dl>
        </div>
      </div>
    }
  `,
})
export class SystemSection {
  private readonly api = inject(ApiService);
  private readonly store = inject(WorkspaceStore);
  readonly snap = signal<SystemSnapshot | null>(null);
  readonly error = signal<string | null>(null);
  readonly mb = mb;
  readonly pct = pct;
  readonly duration = duration;

  readonly services = computed(() => this.snap()?.services.length
    ? this.snap()!.services
    : this.snap() ? [{ name: 'api', cpuPercent: this.snap()!.api.cpuPercent, memoryMb: this.snap()!.api.memoryMb, memoryLimitMb: null }] : []);
  readonly memScale = computed(() => Math.max(1, ...this.services().map((s) => s.memoryLimitMb ?? s.memoryMb)));
  private readonly history = computed(() => this.snap()?.history ?? []);
  readonly span = computed(() => {
    const h = this.history();
    if (h.length < 2) return 'minute';
    const s = (Date.parse(h[h.length - 1].at) - Date.parse(h[0].at)) / 1000;
    return s >= 3000 ? 'hour' : `${Math.max(1, Math.round(s / 60))} min`;
  });
  /** Round the CPU scale up to 5/10/25/50/100 so small numbers stay readable. */
  readonly cpuMax = computed(() => {
    const top = Math.max(...this.history().map((p) => Math.max(p.projectCpu, p.hostCpu ?? 0)), 1);
    return [5, 10, 25, 50, 100].find((s) => top <= s) ?? 100;
  });
  readonly cpuProject = computed(() => line(this.history().map((p) => p.projectCpu), this.cpuMax()));
  readonly cpuHost = computed(() => line(this.history().map((p) => p.hostCpu), this.cpuMax()));
  readonly memPeak = computed(() => Math.max(0, ...this.history().map((p) => p.projectMemoryMb)));
  readonly memMax = computed(() => {
    const peak = this.memPeak() * 1.15 || 1;
    const step = peak > 2048 ? 512 : peak > 512 ? 128 : 32;
    return Math.ceil(peak / step) * step;
  });
  readonly memProject = computed(() => line(this.history().map((p) => p.projectMemoryMb), this.memMax()));

  nice(name: string): string {
    return NICE[name] ?? name;
  }

  constructor() {
    void this.load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.load();
    }, 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private async load(): Promise<void> {
    const id = this.store.serverId();
    if (!id) return;
    try {
      this.snap.set(await this.api.get<SystemSnapshot>(`/servers/${id}/system`));
      this.error.set(null);
    } catch (e) {
      if (!this.snap()) this.error.set(ApiError.from(e).message);
    }
  }
}
