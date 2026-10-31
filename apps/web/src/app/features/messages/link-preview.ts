import { ChangeDetectionStrategy, Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { Icon } from '../../shared/ui/icon';
import { WatchTogether } from '../voice/watch-together';

export interface LinkPreview {
  url: string;
  kind: 'page' | 'image';
  siteName: string | null;
  title: string | null;
  description: string | null;
  /** Same-origin proxy path (the browser never contacts the linked site). */
  imageUrl: string | null;
  themeColor: string | null;
  youtubeId: string | null;
}

const MAX_PER_MESSAGE = 3;
const LINK = /(<)?(https?:\/\/[^\s<>"]+)/g;

/** Links in a message body that get a card: up to three, not wrapped in <…> (Discord's "no preview" syntax). */
export function previewUrls(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(LINK)) {
    const url = m[2].replace(/[).,!?:;]+$/, '');
    const end = (m.index ?? 0) + m[0].length;
    if (m[1] && body[end] === '>') continue;
    if (!out.includes(url)) out.push(url);
    if (out.length === MAX_PER_MESSAGE) break;
  }
  return out;
}

/** Previews per URL for this session: null = nothing to show; missing = not asked yet. */
@Injectable({ providedIn: 'root' })
export class LinkPreviews {
  private readonly api = inject(ApiService);
  private readonly cache = signal<Record<string, LinkPreview | null>>({});
  private readonly asked = new Set<string>();

  constructor() {
    inject(SessionService).onTeardown(() => {
      this.cache.set({});
      this.asked.clear();
    });
  }

  get(url: string): LinkPreview | null | undefined {
    const v = this.cache()[url];
    if (v === undefined && !this.asked.has(url)) {
      this.asked.add(url);
      queueMicrotask(() => void this.load(url));
    }
    return v;
  }

  private async load(url: string): Promise<void> {
    let preview: LinkPreview | null = null;
    try {
      preview = (await this.api.get<LinkPreview | null>('/link-previews', { url })) ?? null;
    } catch {
      // Rate limited or offline: allow another try later in the session.
      setTimeout(() => this.asked.delete(url), 60_000);
    }
    this.cache.update((c) => ({ ...c, [url]: preview }));
  }
}

/** One link card under a message (site, title, description, image; YouTube with a play badge). */
@Component({
  selector: 'hx-link-preview',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (preview(); as p) {
      @if (p.kind === 'image') {
        <a class="lp-img" [href]="url()" target="_blank" rel="noopener noreferrer nofollow" [attr.aria-label]="'Image from ' + host()">
          <img [src]="p.imageUrl" alt="" loading="lazy" decoding="async" (error)="broken.set(true)" [hidden]="broken()" />
        </a>
      } @else {
        <div class="lp" [style.border-inline-start-color]="p.themeColor || null" data-testid="link-preview">
          <div class="lp-site">{{ p.siteName }}</div>
          @if (p.title) {
            <a class="lp-title" [href]="url()" target="_blank" rel="noopener noreferrer nofollow" dir="auto">{{ p.title }}</a>
          }
          @if (p.description) { <div class="lp-desc" dir="auto">{{ p.description }}</div> }
          @if (p.imageUrl && !broken()) {
            <a class="lp-media" [class.video]="!!p.youtubeId" [href]="url()" target="_blank" rel="noopener noreferrer nofollow"
               [attr.aria-label]="p.youtubeId ? 'Play ' + (p.title ?? 'video') + ' on YouTube' : 'Open ' + (p.title ?? host())">
              <img [src]="p.imageUrl" alt="" loading="lazy" decoding="async" (error)="broken.set(true)" />
              @if (p.youtubeId) { <span class="lp-play" aria-hidden="true"><hx-icon name="play" /></span> }
            </a>
          }
          @if (p.youtubeId && media.connected()) {
            <button class="btn sec" style="align-self: flex-start; height: 30px; margin-top: 6px; font-size: 12.5px" (click)="together.start(url())">
              <hx-icon name="tv" size="sm" />Watch together in the call
            </button>
          }
        </div>
      }
    }
  `,
})
export class LinkPreviewCard {
  readonly url = input.required<string>();
  private readonly previews = inject(LinkPreviews);
  readonly media = inject(MediaSessionService);
  readonly together = inject(WatchTogether);
  readonly preview = computed(() => this.previews.get(this.url()) ?? null);
  readonly broken = signal(false);

  host(): string {
    try {
      return new URL(this.url()).host;
    } catch {
      return 'link';
    }
  }
}
