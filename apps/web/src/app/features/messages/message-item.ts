import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Perm, has } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { avatarColor, avatarUrl, initials } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Attachment } from '../../core/api/models';
import { formatSize } from './attachment-uploads';
import { ChannelUi } from './channel-ui';
import { ChatMessage, ChatStore } from './chat.store';
import { QUICK_REACTIONS, decodeMentions, encodeMentions, formatFull, formatTime, parseBody, previewText } from './message-text';

/** One message row (prototype `article.msg`): header, reply ref, body/edit, reactions, hover toolbar. */
@Component({
  selector: 'hx-message',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let m = message();
    <article [id]="'msg-' + m.id" class="msg" [class.grouped]="grouped()" [class.me-mention]="mentionsMe()" [class.hl]="ui.highlightId() === m.id"
             [style.opacity]="m.pending === 'sending' ? 0.6 : null" [attr.aria-label]="aria()">
      <div class="gut">
        @if (!grouped()) {
          <span class="av s40" [style.background]="color()" aria-hidden="true">@if (avatarSrc(); as u) {<img [src]="u" alt="" />} @else {{{ ini() }}}</span>
        } @else {
          <div class="ts mono" [title]="full()">{{ time() }}</div>
        }
      </div>
      <div style="flex: 1; min-width: 0">
        @if (m.replyTo; as r) {
          <button class="replyref" (click)="r.deleted ? null : ui.jumpTo(r.id)" [disabled]="r.deleted">
            <hx-icon name="reply" size="sm" style="transform: scaleX(-1) rotate(180deg)" />
            @if (r.deleted) {
              <i>Original message was deleted</i>
            } @else {
              <span class="av s20" [style.background]="replyColor()" style="width: 16px; height: 16px; font-size: 8px">{{ replyIni() }}</span>
              <b style="font-weight: 600; color: var(--tx2)">{{ replyName() }}</b>
              <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px">{{ replyText() }}</span>
            }
          </button>
        }
        @if (!grouped()) {
          <div style="display: flex; align-items: baseline; gap: 8px">
            <span class="uname" [style.color]="color()">{{ name() }}</span>
            @if (isAdmin()) {
              <span style="font-size: 10px; font-weight: 600; letter-spacing: .06em; padding: 1px 5px; border-radius: 4px; background: var(--bg4); color: var(--tx2)">ADMIN</span>
            }
            <time class="mtime mono" [attr.datetime]="m.createdAt" [title]="full()">{{ time() }}</time>
            @if (m.pinned) {
              <span style="font-size: 11px; color: var(--tx3); display: inline-flex; align-items: center; gap: 3px"><hx-icon name="pin" size="sm" style="width: 12px; height: 12px" />pinned</span>
            }
          </div>
        }
        @if (editing()) {
          <div style="margin-top: 4px">
            <input #editInput class="inp" aria-label="Edit message" [value]="editText()" (input)="editText.set($any($event.target).value)"
                   (keydown)="onEditKey($event)" maxlength="4000" style="width: 100%; background: var(--bg3)" />
            <div style="font-size: 11.5px; color: var(--tx3); margin-top: 6px">
              Enter to <button (click)="saveEdit()" style="color: var(--accent-tx); font-weight: 600">save</button> ·
              Esc to <button (click)="ui.editingId.set(null)" style="color: var(--accent-tx); font-weight: 600">cancel</button>
            </div>
          </div>
        } @else {
          <div class="mtext">@for (p of parts(); track $index) {@switch (p.kind) {@case ('mention') {<span class="mention">{{ p.text }}</span>}@case ('everyone') {<span class="mention">{{ p.text }}</span>}@case ('link') {<a [href]="p.href" target="_blank" rel="noopener noreferrer nofollow" style="color: var(--accent-tx); text-decoration: underline">{{ p.text }}</a>}@default {<span>{{ p.text }}</span>}}}@if (m.editedAt) {<span style="font-size: 11px; color: var(--tx3)" [title]="'Edited ' + fullEdited()"> (edited)</span>}</div>
        }
        @for (a of m.attachments; track a.id) {
          @if (isImage(a)) {
            <button class="img att-img" (click)="ui.viewer.set({ attachment: a, by: name() })" [attr.aria-label]="'Open image ' + a.name"
                    [style.aspect-ratio]="a.width && a.height ? a.width + ' / ' + a.height : null"
                    [style.width.px]="imgWidth(a)" style="background: var(--bg3)">
              <img [src]="'/api/v1/attachments/' + a.id" [alt]="a.name" loading="lazy" decoding="async"
                   style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover" />
            </button>
          } @else {
            <div class="att-file" style="display: flex; width: fit-content; max-width: 100%; align-items: center; gap: 10px; margin-top: 6px; padding: 10px 12px; border-radius: 10px; background: var(--bg3); border: 1px solid var(--line)">
              <hx-icon name="file" style="color: var(--accent-tx); flex: none" />
              <div style="min-width: 0">
                <div style="font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ a.name }}</div>
                <div class="mono" style="font-size: 11px; color: var(--tx3)">{{ size(a.size) }}</div>
              </div>
              <a class="ibtn" [href]="'/api/v1/attachments/' + a.id + '?download=true'" download [attr.aria-label]="'Download ' + a.name" title="Download"><hx-icon name="download" size="sm" /></a>
            </div>
          }
        }
        @if (m.pending === 'failed') {
          <div role="alert" style="display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; color: var(--danger)">
            <hx-icon name="alert-circle" size="sm" />Not sent.
            <button (click)="chat.retry(m)" style="color: var(--accent-tx); font-weight: 600">Retry</button>
            <button (click)="chat.discard(m)" style="color: var(--tx3)">Discard</button>
          </div>
        }
        @if (m.reactions.length) {
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px">
            @for (r of m.reactions; track r.emoji) {
              <button class="react" [class.mine]="r.userIds.includes(me() ?? '')" (click)="react(r.emoji)" [disabled]="!canReact() && !r.userIds.includes(me() ?? '')"
                      [attr.aria-pressed]="r.userIds.includes(me() ?? '')" [attr.aria-label]="r.emoji + ' ' + r.count + ' reactions'" [title]="who(r.userIds)">
                <span style="font-size: 14px">{{ r.emoji }}</span><span class="mono">{{ r.count }}</span>
              </button>
            }
            @if (canReact()) {
              <button class="react" (click)="toggleReact()" aria-label="Add reaction" style="color: var(--tx3)"><hx-icon name="smile" size="sm" /></button>
            }
          </div>
        }
      </div>
      @if (!m.pending) {
        <div class="acts" [class.open]="reactOpen()" role="toolbar" aria-label="Message actions">
          @if (reactOpen()) {
            <div style="display: flex; gap: 2px; padding-right: 4px; margin-right: 2px; border-right: 1px solid var(--line)">
              @for (e of quick; track e) {
                <button class="ibtn" style="font-size: 16px" (click)="react(e); ui.reactFor.set(null)" [attr.aria-label]="'React ' + e">{{ e }}</button>
              }
            </div>
          }
          @if (canReact()) {
            <button class="ibtn" aria-label="Add reaction" title="React" (click)="toggleReact()"><hx-icon name="smile" size="sm" /></button>
          }
          @if (canSend()) {
            <button class="ibtn" aria-label="Reply" title="Reply" (click)="ui.startReply(m)"><hx-icon name="reply" size="sm" /></button>
          }
          @if (canManage()) {
            <button class="ibtn" [attr.aria-label]="m.pinned ? 'Unpin' : 'Pin'" [title]="m.pinned ? 'Unpin' : 'Pin'" (click)="chat.setPinned(m, !m.pinned)"><hx-icon name="pin" size="sm" /></button>
          }
          @if (mine() && canSend()) {
            <button class="ibtn" aria-label="Edit" title="Edit" (click)="startEdit()"><hx-icon name="edit" size="sm" /></button>
          }
          @if (mine() || canManage()) {
            <button class="ibtn" aria-label="Delete" title="Delete (Shift+click skips confirmation)" (click)="askDelete($event)" style="color: var(--danger)"><hx-icon name="trash" size="sm" /></button>
          }
        </div>
      }
    </article>
  `,
})
export class MessageItem {
  readonly message = input.required<ChatMessage>();
  readonly grouped = input(false);
  readonly perms = input(0);
  readonly isAdmin = input(false);

  readonly ui = inject(ChannelUi);
  readonly chat = inject(ChatStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly session = inject(SessionService);

  readonly quick = QUICK_REACTIONS;
  readonly editText = signal('');
  private readonly editInput = viewChild<ElementRef<HTMLInputElement>>('editInput');

  readonly me = this.session.userId;
  readonly author = computed(() => this.workspace.memberById().get(this.message().authorUserId));
  readonly name = computed(() => this.author()?.displayName ?? 'Former member');
  readonly color = computed(() => avatarColor(this.author()?.avatarHue ?? 210));
  readonly ini = computed(() => initials(this.name()));
  readonly avatarSrc = computed(() => avatarUrl(this.author()?.avatarAssetId));
  readonly time = computed(() => formatTime(this.message().createdAt));
  readonly full = computed(() => formatFull(this.message().createdAt));
  readonly fullEdited = computed(() => (this.message().editedAt ? formatFull(this.message().editedAt!) : ''));
  readonly parts = computed(() => parseBody(this.message().body, this.workspace.memberById()));
  readonly mine = computed(() => this.message().authorUserId === this.me());
  readonly mentionsMe = computed(() => {
    const m = this.message();
    const me = this.me();
    return !!me && m.authorUserId !== me && (m.mentions.includes(me) || m.mentionsEveryone);
  });
  readonly editing = computed(() => this.ui.editingId() === this.message().id);
  readonly reactOpen = computed(() => this.ui.reactFor() === this.message().id);
  readonly canSend = computed(() => has(this.perms(), Perm.SendMessages));
  readonly canReact = computed(() => has(this.perms(), Perm.AddReactions));
  readonly canManage = computed(() => has(this.perms(), Perm.ManageMessages));
  readonly aria = computed(() => `${this.name()} at ${this.time()}: ${previewText(this.message().body, this.workspace.memberById())}`);

  readonly replyAuthor = computed(() => {
    const r = this.message().replyTo;
    return r ? this.workspace.memberById().get(r.authorUserId) : undefined;
  });
  readonly replyName = computed(() => this.replyAuthor()?.displayName ?? 'Former member');
  readonly replyColor = computed(() => avatarColor(this.replyAuthor()?.avatarHue ?? 210));
  readonly replyIni = computed(() => initials(this.replyName()));
  readonly replyText = computed(() => previewText(this.message().replyTo?.bodyPreview ?? '', this.workspace.memberById()));

  readonly size = formatSize;

  isImage(a: Attachment): boolean {
    return a.mime.startsWith('image/');
  }

  /** Fits the image in a 380×300 box keeping its aspect ratio (prototype `.img` is 380 px wide). */
  imgWidth(a: Attachment): number | null {
    if (!a.width || !a.height) return null;
    return Math.max(80, Math.round(Math.min(380, a.width, (300 * a.width) / a.height)));
  }

  constructor() {
    effect(() => {
      const el = this.editInput()?.nativeElement;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  who(userIds: string[]): string {
    const byId = this.workspace.memberById();
    return userIds.map((u) => byId.get(u)?.displayName ?? 'Someone').join(', ');
  }

  react(emoji: string): void {
    void this.chat.toggleReaction(this.message(), emoji);
  }

  toggleReact(): void {
    this.ui.reactFor.update((id) => (id === this.message().id ? null : this.message().id));
  }

  startEdit(): void {
    this.editText.set(decodeMentions(this.message().body, this.workspace.memberById()));
    this.ui.editingId.set(this.message().id);
  }

  async saveEdit(): Promise<void> {
    const body = encodeMentions(this.editText().trim(), this.workspace.members());
    const m = this.message();
    if (!body) {
      this.ui.deleting.set(m);
      return;
    }
    if (body !== m.body) {
      try {
        await this.chat.edit(m, body);
      } catch {
        return;
      }
    }
    this.ui.editingId.set(null);
    this.ui.focusComposer();
  }

  onEditKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.ui.editingId.set(null);
      this.ui.focusComposer();
    }
  }

  askDelete(e: MouseEvent): void {
    if (e.shiftKey) void this.chat.remove(this.message());
    else this.ui.deleting.set(this.message());
  }
}
