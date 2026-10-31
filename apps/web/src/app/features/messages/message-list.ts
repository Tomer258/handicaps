import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Channel, Perm, has, seqCmp } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ChannelUi } from './channel-ui';
import { ChatMessage, ChatStore } from './chat.store';
import { MessageItem } from './message-item';
import { dayKey, dayLabel } from './message-text';

interface Row {
  m: ChatMessage;
  grouped: boolean;
  day: string | null;
  unread: boolean;
}

const GROUP_WINDOW_MS = 7 * 60_000;

/**
 * Scrollable history: day separators, "New messages" divider, author grouping, infinite scroll upward.
 * Sticks to the bottom while the user is there; preserves position when older pages are prepended.
 */
@Component({
  selector: 'hx-message-list',
  imports: [MessageItem, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #scroller class="scroll" style="flex: 1; min-height: 0; padding: 8px 0 12px" (scroll)="onScroll()" role="log" aria-live="polite"
         [attr.aria-label]="'Messages in ' + channel().name" tabindex="-1">
      @if (!chatState().loaded) {
        <div role="status" aria-label="Loading messages" style="padding-top: 12px">
          @for (s of skeleton; track $index) {
            <div class="skrow" aria-hidden="true">
              <div class="sk av40"></div>
              <div class="lines">
                <div class="sk ln" [style.width.%]="s.name"></div>
                <div class="sk ln" [style.width.%]="s.text"></div>
                @if (s.media) { <div class="sk" style="width: 70%; max-width: 420px; height: 90px; border-radius: 10px"></div> }
              </div>
            </div>
          }
        </div>
      } @else {
        @if (chatState().hasMore) {
          <div style="display: grid; place-items: center; padding: 12px">
            @if (chatState().loadingOlder) {
              <span class="spin" aria-label="Loading older messages"></span>
            } @else {
              <button class="btn ghost" (click)="loadOlder()">Load older messages</button>
            }
          </div>
        } @else if (rows().length) {
          <div style="padding: 24px 20px 8px">
            <div style="width: 56px; height: 56px; border-radius: 18px; background: var(--bg3); border: 1px solid var(--line); display: grid; place-items: center; color: var(--accent-tx)">
              <hx-icon [name]="icon()" size="lg" />
            </div>
            <h2 class="disp" style="margin: 12px 0 4px; font-size: 22px; font-weight: 700">Welcome to {{ prefix() }}{{ channel().name }}</h2>
            <p style="margin: 0; color: var(--tx2)">This is the start of the channel.@if (channel().topic) { {{ channel().topic }}}</p>
          </div>
        }
        @if (!rows().length && !chatState().hasMore) {
          <div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 40px; text-align: center">
            <div style="position: relative; width: 96px; height: 96px; border-radius: 28px; background: var(--bg3); border: 1px solid var(--line); display: grid; place-items: center; color: var(--accent-tx)">
              <hx-icon [name]="icon()" style="width: 40px; height: 40px; stroke-width: 1.4" />
              <span style="position: absolute; right: -8px; top: -8px; width: 26px; height: 26px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center"><hx-icon name="plus" size="sm" /></span>
            </div>
            <h2 class="disp" style="margin: 0; font-size: 24px; font-weight: 700">This is the start of {{ prefix() }}{{ channel().name }}</h2>
            <p style="margin: 0; max-width: 380px; color: var(--tx2)">Nobody has posted here yet. Share a link or write the first message — it is a blank page.</p>
            @if (canSend()) {
              <button class="btn pri" (click)="ui.focusComposer()">Write the first message</button>
            }
          </div>
        }
        @for (r of rows(); track r.m.clientMessageId) {
          @if (r.day) {
            <div class="daysep" role="separator">{{ r.day }}</div>
          }
          @if (r.unread) {
            <div class="sep" role="separator">New messages</div>
          }
          <hx-message [message]="r.m" [grouped]="r.grouped" [perms]="channel().permissions" [isAdmin]="admins().has(r.m.authorUserId)" />
        }
      }
    </div>
    @if (!atBottom() && chatState().loaded) {
      <button class="btn" (click)="scrollToBottom(true)" style="position: absolute; right: 24px; bottom: 96px; z-index: 5; height: 32px; box-shadow: 0 6px 18px rgba(0,0,0,.3)">
        <hx-icon name="chevron-down" size="sm" />Jump to present
      </button>
    }
  `,
  host: { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative' },
})
export class MessageList {
  readonly channel = input.required<Channel>();
  readonly prefix = computed(() => (this.channel().type === 'text' ? '#' : this.channel().type === 'direct' ? '@' : ''));
  readonly icon = computed(() => (this.channel().type === 'group' ? 'users' : this.channel().type === 'direct' ? 'message' : 'hash'));
  /** Placeholder rows while history loads (widths vary so it reads as messages, not a table). */
  readonly skeleton = [
    { name: 30, text: 85, media: false },
    { name: 22, text: 60, media: true },
    { name: 26, text: 72, media: false },
    { name: 18, text: 45, media: false },
  ];

  readonly ui = inject(ChannelUi);
  private readonly chat = inject(ChatStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');

  readonly atBottom = signal(true);
  /** Read position captured when the channel opened; the divider stays put while reading. */
  private readonly unreadAfter = signal<string | null>(null);
  private lastChannelId = '';
  private lastFirstKey: string | undefined;
  private lastLastKey: string | undefined;
  private distanceFromBottom = 0;
  private initialScrollDone = false;

  readonly chatState = computed(() => this.chat.chat(this.channel().id));
  readonly canSend = computed(() => has(this.channel().permissions, Perm.SendMessages));

  readonly admins = computed(() => {
    const server = this.workspace.server();
    const adminRoles = new Set((server?.roles ?? []).filter((r) => has(r.permissions, Perm.Administrator)).map((r) => r.id));
    return new Set(this.workspace.members().filter((m) => m.isOwner || m.roleIds.some((id) => adminRoles.has(id))).map((m) => m.userId));
  });

  readonly rows = computed<Row[]>(() => {
    const me = this.session.userId();
    const after = this.unreadAfter();
    const list = this.chatState().messages.filter((m) => !m.deleted);
    const rows: Row[] = [];
    let unreadShown = false;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const prev = list[i - 1];
      const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
      const unread =
        !unreadShown && after !== null && !m.pending && m.authorUserId !== me && seqCmp(m.messageSequence, after) > 0 && seqCmp(after, '0') > 0;
      if (unread) unreadShown = true;
      const grouped =
        !!prev && !newDay && !unread && !m.replyTo && prev.authorUserId === m.authorUserId &&
        m.kind !== 'memberJoined' && prev.kind !== 'memberJoined' &&
        new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
      rows.push({ m, grouped, day: newDay ? dayLabel(m.createdAt) : null, unread });
    }
    return rows;
  });

  constructor() {
    // Channel switch: reset scroll bookkeeping, capture the read marker once history is loaded.
    effect(() => {
      const id = this.channel().id;
      const state = this.chatState();
      untracked(() => {
        if (id !== this.lastChannelId) {
          this.lastChannelId = id;
          this.unreadAfter.set(state.loaded ? state.lastRead : null);
          this.initialScrollDone = false;
          this.lastFirstKey = this.lastLastKey = undefined;
          this.setAtBottom(true);
        } else if (state.loaded && this.unreadAfter() === null) {
          this.unreadAfter.set(state.lastRead);
        }
      });
    });

    afterRenderEffect(() => {
      const rows = this.rows();
      const loaded = this.chatState().loaded;
      untracked(() => {
        const el = this.scroller().nativeElement;
        if (!loaded) return;
        const firstKey = rows[0]?.m.clientMessageId;
        const lastKey = rows[rows.length - 1]?.m.clientMessageId;
        if (!this.initialScrollDone) {
          this.initialScrollDone = true;
          const sep = el.querySelector('.sep');
          if (sep) sep.scrollIntoView({ block: 'center' });
          else el.scrollTop = el.scrollHeight;
          this.onScroll();
        } else if (firstKey !== this.lastFirstKey && lastKey === this.lastLastKey) {
          // Older page prepended: keep the same content under the viewport.
          el.scrollTop = el.scrollHeight - el.clientHeight - this.distanceFromBottom;
        } else if (this.atBottom()) {
          el.scrollTop = el.scrollHeight;
        }
        this.lastFirstKey = firstKey;
        this.lastLastKey = lastKey;
        this.distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      });
    });
  }

  onScroll(): void {
    const el = this.scroller().nativeElement;
    this.distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    this.setAtBottom(this.distanceFromBottom < 48);
    if (el.scrollTop < 240 && this.initialScrollDone) void this.loadOlder();
  }

  async loadOlder(): Promise<void> {
    try {
      await this.chat.loadOlder(this.channel().id);
    } catch {
      /* the button stays available for a manual retry */
    }
  }

  scrollToBottom(smooth = false): void {
    const el = this.scroller().nativeElement;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  private setAtBottom(v: boolean): void {
    if (this.atBottom() !== v) this.atBottom.set(v);
    this.chat.atBottom.set(v);
    if (v && this.chatState().loaded) this.chat.scheduleRead(this.channel().id);
  }
}
