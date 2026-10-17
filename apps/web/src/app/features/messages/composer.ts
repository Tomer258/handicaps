import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Channel, Member, Perm, has } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { Avatar } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ChannelUi } from './channel-ui';
import { ChatStore } from './chat.store';
import { EMOJIS, encodeMentions, previewText } from './message-text';

const MAX_LENGTH = 4000;
const TYPING_EVERY_MS = 3000;

interface Suggestion {
  key: string;
  label: string;
  sub: string;
  insert: string;
  member?: Member;
}

/** Message composer (prototype `.composer`): reply bar, @mention suggestions, emoji picker, typing signal. */
@Component({
  selector: 'hx-composer',
  imports: [Icon, Avatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="composer" style="position: relative">
      @if (ui.replyTo(); as r) {
        <div class="fade" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--tx3)">
          <hx-icon name="reply" size="sm" />
          <span>Replying to <b [style.color]="replyColor()" style="font-weight: 600">{{ replyName() }}</b></span>
          <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">— {{ replyText() }}</span>
          <button class="ibtn" style="width: 24px; height: 24px" aria-label="Cancel reply" (click)="ui.replyTo.set(null)"><hx-icon name="x" size="sm" /></button>
        </div>
      }
      @if (suggestions().length) {
        <div class="pop fade" role="listbox" aria-label="Mention suggestions" style="position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px); padding: 6px; z-index: 12">
          <div class="lbl" style="margin: 2px 6px 6px">Members</div>
          @for (s of suggestions(); track s.key; let i = $index) {
            <button role="option" [attr.aria-selected]="i === active()" (mousedown)="$event.preventDefault(); pick(s)"
                    style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border-radius: 8px; text-align: left"
                    [style.background]="i === active() ? 'var(--bg4)' : null">
              @if (s.member; as m) {
                <hx-avatar [name]="m.displayName" [hue]="m.avatarHue" [size]="20" />
              } @else {
                <span class="av s20" style="background: var(--accent); color: var(--accent-ink)">&#64;</span>
              }
              <b style="font-weight: 600; font-size: 13.5px">{{ s.label }}</b>
              <span class="mono" style="font-size: 11.5px; color: var(--tx3)">{{ s.sub }}</span>
            </button>
          }
        </div>
      }
      <div style="display: flex; align-items: flex-end; gap: 4px; padding: 0 8px">
        <textarea #box id="composer" class="txt" rows="1" [attr.aria-label]="'Message ' + channel().name" autocomplete="off"
                  [placeholder]="canSend() ? 'Message #' + channel().name : 'You cannot send messages in this channel'"
                  [disabled]="!canSend()" [value]="draft()" [maxLength]="maxLength"
                  (input)="onInput()" (keydown)="onKey($event)" (click)="refreshSuggestions()" (blur)="closeSuggestions()"></textarea>
        @if (draft().length > maxLength - 200) {
          <span class="mono" style="align-self: center; font-size: 11px" [style.color]="draft().length >= maxLength ? 'var(--danger)' : 'var(--tx3)'">{{ maxLength - draft().length }}</span>
        }
        <button class="ibtn" [class.on]="ui.emojiOpen()" aria-label="Emoji" [attr.aria-pressed]="ui.emojiOpen()" title="Emoji" (click)="ui.emojiOpen.set(!ui.emojiOpen())"
                [disabled]="!canSend()" style="margin-bottom: 7px"><hx-icon name="smile" /></button>
        <button class="ibtn" aria-label="Send message" title="Send" (click)="send()" [disabled]="!canSend() || !draft().trim()"
                style="color: var(--accent-tx); margin-bottom: 7px"><hx-icon name="send" /></button>
      </div>
      @if (ui.emojiOpen()) {
        <div class="pop fade" style="position: absolute; right: 8px; bottom: 56px; width: 312px; padding: 12px; z-index: 12">
          <div class="lbl" style="margin-bottom: 8px">Frequently used</div>
          <div style="display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 2px">
            @for (e of emojis; track e) {
              <button class="ibtn" style="font-size: 20px; width: 100%; height: 34px" (click)="insert(e)" [attr.aria-label]="'Insert ' + e">{{ e }}</button>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class Composer {
  readonly channel = input.required<Channel>();

  readonly ui = inject(ChannelUi);
  private readonly chat = inject(ChatStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly realtime = inject(RealtimeService);
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');

  readonly emojis = EMOJIS;
  readonly maxLength = MAX_LENGTH;
  readonly draft = signal('');
  readonly suggestions = signal<Suggestion[]>([]);
  readonly active = signal(0);
  private lastTyping = 0;
  private channelId = '';

  readonly canSend = computed(() => has(this.channel().permissions, Perm.SendMessages));
  readonly canEveryone = computed(() => has(this.channel().permissions, Perm.MentionEveryone));

  private readonly replyAuthor = computed(() => {
    const r = this.ui.replyTo();
    return r ? this.workspace.memberById().get(r.authorUserId) : undefined;
  });
  readonly replyName = computed(() => this.replyAuthor()?.displayName ?? 'Former member');
  readonly replyColor = computed(() => `hsl(${this.replyAuthor()?.avatarHue ?? 210} 75% 72%)`);
  readonly replyText = computed(() => previewText(this.ui.replyTo()?.body ?? '', this.workspace.memberById()));

  constructor() {
    // Swap drafts on channel change (the page component is reused across channels).
    effect(() => {
      const id = this.channel().id;
      untracked(() => {
        if (this.channelId) this.chat.drafts.set(this.channelId, this.draft());
        this.channelId = id;
        this.draft.set(this.chat.drafts.get(id) ?? '');
        this.suggestions.set([]);
        queueMicrotask(() => this.autosize());
      });
    });
  }

  onInput(): void {
    const el = this.box().nativeElement;
    this.draft.set(el.value);
    this.chat.drafts.set(this.channelId, el.value);
    this.autosize();
    this.refreshSuggestions();
    if (el.value.trim() && Date.now() - this.lastTyping > TYPING_EVERY_MS) {
      this.lastTyping = Date.now();
      this.realtime.typing(this.channelId);
    }
  }

  onKey(e: KeyboardEvent): void {
    const list = this.suggestions();
    if (list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.active.set((this.active() + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.pick(list[this.active()]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSuggestions();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.send();
    } else if (e.key === 'Escape') {
      if (this.ui.emojiOpen()) this.ui.emojiOpen.set(false);
      else this.ui.replyTo.set(null);
    } else if (e.key === 'ArrowUp' && !this.draft()) {
      // Edit my last message, like the desktop clients do.
      const me = this.session.userId();
      const last = [...this.chat.chat(this.channelId).messages].reverse().find((m) => m.authorUserId === me && !m.pending && !m.deleted);
      if (last) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>(`#msg-${last.id} .acts button[aria-label="Edit"]`)?.click();
      }
    }
  }

  async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || !this.canSend()) return;
    const body = encodeMentions(text, this.workspace.members());
    const replyTo = this.ui.replyTo();
    this.draft.set('');
    this.chat.drafts.delete(this.channelId);
    this.ui.replyTo.set(null);
    this.ui.emojiOpen.set(false);
    this.suggestions.set([]);
    this.lastTyping = 0;
    queueMicrotask(() => this.autosize());
    await this.chat.send(this.channelId, body, replyTo);
  }

  insert(text: string): void {
    const el = this.box().nativeElement;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, 'end');
    el.focus();
    this.onInput();
  }

  pick(s: Suggestion): void {
    const el = this.box().nativeElement;
    const caret = el.selectionStart ?? el.value.length;
    const m = /@([\p{L}\p{N}._-]{0,32})$/u.exec(el.value.slice(0, caret));
    if (!m) return;
    el.setRangeText(s.insert + ' ', caret - m[0].length, caret, 'end');
    el.focus();
    this.onInput();
    this.suggestions.set([]);
  }

  refreshSuggestions(): void {
    const el = this.box().nativeElement;
    const caret = el.selectionStart ?? el.value.length;
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,32})$/u.exec(el.value.slice(0, caret));
    if (!m) {
      this.closeSuggestions();
      return;
    }
    const q = m[2].toLowerCase();
    const out: Suggestion[] = this.workspace
      .members()
      .filter((x) => x.login.startsWith(q) || x.displayName.toLowerCase().startsWith(q))
      .slice(0, 6)
      .map((x) => ({ key: x.userId, label: x.displayName, sub: '@' + x.login, insert: '@' + x.login, member: x }));
    if (this.canEveryone() && 'everyone'.startsWith(q)) out.push({ key: 'everyone', label: 'everyone', sub: 'Notify everyone here', insert: '@everyone' });
    this.suggestions.set(out);
    if (this.active() >= out.length) this.active.set(0);
  }

  closeSuggestions(): void {
    if (this.suggestions().length) this.suggestions.set([]);
    this.active.set(0);
  }

  private autosize(): void {
    const el = this.box().nativeElement;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }
}
