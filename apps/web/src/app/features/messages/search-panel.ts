import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Message } from '../../core/api/models';
import { avatarColor, avatarUrl, initials } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { LayoutService } from '../shell/layout.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { previewText } from './message-text';

const DEBOUNCE_MS = 250;
const PAGE = 25;

interface SearchPage {
  messages: Message[];
  next: string | null;
}

/** Parsed query: `from:<login>` and `in:<channel>` filters plus free text (prototype hint chips use the same syntax). */
interface Parsed {
  text: string;
  from: string | null;
  fromLabel: string | null;
  channel: string | null;
  channelLabel: string | null;
  error: string | null;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Server-wide message search (prototype SEARCH panel, Ctrl K). Results come from the API, scoped to visible channels. */
@Component({
  selector: 'hx-search-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pop fade" role="dialog" aria-label="Search messages" (keydown.escape)="close()"
         style="position: absolute; right: 12px; top: 8px; width: 400px; max-width: calc(100% - 24px); max-height: 75%; display: flex; flex-direction: column; z-index: 16">
      <div style="display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line)">
        <hx-icon name="search" style="color: var(--tx3); margin-left: 4px" />
        <input #box id="search-input" aria-label="Search messages" [placeholder]="'Search ' + (store.server()?.name ?? '')" autocomplete="off" dir="auto"
               [value]="query()" (input)="query.set($any($event.target).value)" (keydown.enter)="runNow()" maxlength="140"
               style="flex: 1; min-width: 0; height: 32px; background: none; border: 0; outline: none; color: inherit" />
        <button class="ibtn" aria-label="Close search" (click)="close()"><hx-icon name="x" size="sm" /></button>
      </div>
      <div style="display: flex; gap: 6px; padding: 10px 12px 0; flex-wrap: wrap">
        @for (h of hints(); track h) {
          <button class="cat" (click)="addFilter(h)">{{ h }}</button>
        }
      </div>
      <div class="scroll" style="padding: 10px" aria-live="polite">
        <div class="lbl" style="margin: 0 2px 8px">{{ summary() }}</div>
        @for (r of rows(); track r.id) {
          <button class="search-hit" (click)="open(r.message)"
                  style="display: flex; gap: 10px; width: 100%; text-align: left; padding: 10px; border-radius: 10px; margin-bottom: 4px; background: var(--bg3)">
            <span class="av s28" [style.background]="r.color" aria-hidden="true">@if (r.avatar; as u) {<img [src]="u" alt="" />} @else {{{ r.ini }}}</span>
            <span style="min-width: 0; flex: 1">
              <span style="display: flex; gap: 8px; align-items: baseline">
                <b style="font-size: 13px">{{ r.name }}</b>
                <span class="mono" style="font-size: 11px; color: var(--tx3); white-space: nowrap">{{ r.channel }} · {{ r.time }}</span>
              </span>
              <span dir="auto" style="display: block; font-size: 13px; color: var(--tx2); overflow-wrap: anywhere">@for (s of r.parts; track $index) {@if (s.hit) {<mark style="background: color-mix(in oklab,var(--accent) 35%,transparent); color: inherit; border-radius: 3px">{{ s.text }}</mark>} @else {{{ s.text }}}}@if (r.files) {<span style="color: var(--tx3)"> · 📎 {{ r.files }}</span>}</span>
            </span>
          </button>
        }
        @if (loading()) {
          <div style="display: grid; place-items: center; padding: 16px"><span class="spin" aria-label="Searching"></span></div>
        } @else if (next()) {
          <button class="btn ghost" style="width: 100%" (click)="more()">Show older results</button>
        }
      </div>
    </div>
  `,
})
export class SearchPanel implements OnDestroy {
  readonly store = inject(WorkspaceStore);
  private readonly api = inject(ApiService);
  private readonly layout = inject(LayoutService);
  private readonly router = inject(Router);
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  readonly query = signal('');
  readonly results = signal<Message[]>([]);
  readonly next = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly searched = signal(false);
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private readonly opener = document.activeElement as HTMLElement | null;

  readonly parsed = computed(() => this.parse(this.query()));

  readonly hints = computed(() => {
    const p = this.parsed();
    const out: string[] = [];
    if (!p.from) for (const m of this.store.members().slice(0, 3)) out.push(`from:${m.login}`);
    if (!p.channel) for (const c of this.store.textChannels().slice(0, 2)) out.push(`in:${c.name}`);
    return out;
  });

  readonly summary = computed(() => {
    const p = this.parsed();
    if (p.error) return p.error;
    if (this.error()) return this.error()!;
    if (!this.searched()) return 'Type to search messages, or try a filter';
    const n = this.results().length;
    const scope = [p.fromLabel && `from ${p.fromLabel}`, p.channelLabel && `in #${p.channelLabel}`].filter(Boolean).join(' ');
    return `${n}${this.next() ? '+' : ''} result${n === 1 ? '' : 's'}${scope ? ' ' + scope : ''}`;
  });

  readonly rows = computed(() => {
    const byId = this.store.memberById();
    const needle = this.parsed().text.toLowerCase();
    return this.results().map((m) => {
      const member = byId.get(m.authorUserId);
      const name = member?.displayName ?? 'Former member';
      return {
        id: m.id,
        message: m,
        name,
        color: avatarColor(member?.avatarHue ?? 210),
        ini: initials(name),
        avatar: avatarUrl(member?.avatarAssetId),
        channel: ((c) => (c ? (c.type === 'text' ? '#' : '') + c.name : '#unknown'))(this.store.channel(m.channelId)),
        time: dateFmt.format(new Date(m.createdAt)),
        parts: highlight(previewText(m.body, byId), needle),
        files: m.attachments.length ? (m.attachments.length === 1 ? m.attachments[0].name : `${m.attachments.length} files`) : '',
      };
    });
  });

  constructor() {
    afterNextRender(() => this.box().nativeElement.focus());
    effect(() => {
      this.parsed();
      this.store.serverId(); // switching servers re-runs the query there
      untracked(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(false), DEBOUNCE_MS);
      });
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
  }

  close(): void {
    this.layout.searchOpen.set(false);
  }

  runNow(): void {
    clearTimeout(this.timer);
    void this.run(false);
  }

  more(): void {
    void this.run(true);
  }

  addFilter(f: string): void {
    const q = this.query().trim();
    this.query.set((q ? `${f} ${q}` : f) + ' ');
    this.box().nativeElement.focus();
  }

  open(m: Message): void {
    const serverId = this.store.serverId();
    if (!serverId) return;
    this.layout.jumpTarget.set({ channelId: m.channelId, messageId: m.id });
    void this.router.navigate(['/s', serverId, 'c', m.channelId]);
    if (this.layout.mobile()) this.close();
  }

  private async run(append: boolean): Promise<void> {
    const p = this.parsed();
    const serverId = this.store.serverId();
    const gen = ++this.generation;
    if (!serverId || p.error || (!p.text && !p.from)) {
      this.results.set([]);
      this.next.set(null);
      this.searched.set(false);
      this.loading.set(false);
      return;
    }
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (p.text) params.set('q', p.text);
    if (p.from) params.set('from', p.from);
    if (p.channel) params.set('channel', p.channel);
    if (append && this.next()) params.set('before', this.next()!);
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.api.get<SearchPage>(`/servers/${serverId}/messages/search?${params}`);
      if (gen !== this.generation) return;
      this.results.update((r) => (append ? [...r, ...page.messages] : page.messages));
      this.next.set(page.next);
      this.searched.set(true);
    } catch (e) {
      if (gen === this.generation) this.error.set(ApiError.from(e).message);
    } finally {
      if (gen === this.generation) this.loading.set(false);
    }
  }

  private parse(raw: string): Parsed {
    let text = raw;
    const out: Parsed = { text: '', from: null, fromLabel: null, channel: null, channelLabel: null, error: null };
    text = text.replace(/(^|\s)from:(\S*)/i, (_, pre: string, who: string) => {
      const w = who.replace(/^@/, '').toLowerCase();
      const m = w ? this.store.members().find((x) => x.login === w) ?? this.store.members().find((x) => x.displayName.toLowerCase().startsWith(w)) : undefined;
      if (m) {
        out.from = m.userId;
        out.fromLabel = m.displayName;
      } else if (w) out.error = `No member matches “${who}”`;
      return pre;
    });
    text = text.replace(/(^|\s)in:#?(\S*)/i, (_, pre: string, name: string) => {
      const n = name.toLowerCase();
      const c = n ? this.store.textChannels().find((x) => x.name.toLowerCase() === n) ?? this.store.textChannels().find((x) => x.name.toLowerCase().startsWith(n)) : undefined;
      if (c) {
        out.channel = c.id;
        out.channelLabel = c.name;
      } else if (n) out.error = `No channel matches “${name}”`;
      return pre;
    });
    out.text = text.replace(/\s+/g, ' ').trim().slice(0, 100);
    return out;
  }
}

/** Splits text into segments, marking case-insensitive occurrences of the needle. */
function highlight(text: string, needle: string): { text: string; hit: boolean }[] {
  if (!needle) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, i)) {
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}
