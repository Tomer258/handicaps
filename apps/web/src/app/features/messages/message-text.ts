import { Member } from '../../core/api/models';

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string; text: string }
  | { kind: 'everyone'; text: string }
  | { kind: 'link'; href: string; text: string };

const TOKEN = /<@([0-9a-fA-F-]{36})>|@everyone|https?:\/\/[^\s<>"]+/g;

/** Splits a message body into renderable parts. Bodies are plain text: never rendered as HTML. */
export function parseBody(body: string, members: Map<string, Member>): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: body.slice(last, at) });
    if (m[1]) {
      const id = m[1].toLowerCase();
      parts.push({ kind: 'mention', userId: id, text: '@' + (members.get(id)?.displayName ?? 'unknown') });
    } else if (m[0] === '@everyone') {
      parts.push({ kind: 'everyone', text: '@everyone' });
    } else {
      // Trailing punctuation usually belongs to the sentence, not the URL.
      const href = m[0].replace(/[).,!?:;]+$/, '');
      parts.push({ kind: 'link', href, text: href });
      if (href.length < m[0].length) parts.push({ kind: 'text', text: m[0].slice(href.length) });
    }
    last = at + m[0].length;
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
  return parts;
}

/** Plain one-line preview (pins, replies, notifications) with mentions resolved. */
export function previewText(body: string, members: Map<string, Member>): string {
  return parseBody(body, members).map((p) => p.text).join('').replace(/\s+/g, ' ').trim();
}

/** Converts typed `@login` tokens to `<@userId>` for known members before sending. */
export function encodeMentions(text: string, members: Member[]): string {
  const byLogin = new Map(members.map((m) => [m.login.toLowerCase(), m]));
  return text.replace(/(^|[\s(])@([a-z0-9._-]{3,32})/gi, (all, pre: string, login: string) => {
    let key = login.toLowerCase();
    while (key && !byLogin.has(key) && /[._-]$/.test(key)) {
      key = key.slice(0, -1);
    }
    const m = byLogin.get(key);
    return m ? `${pre}<@${m.userId}>${login.slice(key.length)}` : all;
  });
}

/** Reverse of encodeMentions for editing: `<@id>` → `@login`. */
export function decodeMentions(body: string, members: Map<string, Member>): string {
  return body.replace(/<@([0-9a-fA-F-]{36})>/g, (all, id: string) => {
    const m = members.get(id.toLowerCase());
    return m ? '@' + m.login : all;
  });
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function formatFull(iso: string): string {
  return fullFmt.format(new Date(iso));
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return 'Today';
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday';
  return dayFmt.format(d);
}

export const QUICK_REACTIONS = ['😂', '🔥', '💀', '👀', '🎉', '👍'];
export const EMOJIS = ['😂', '💀', '🔥', '👀', '🎉', '😭', '👍', '❤️', '🫡', '🤝', '😤', '🏆', '🍿', '🤡', '😎', '🙏', '💯', '🥲', '🤯', '👏', '😐', '🫠', '⚡', '🎮'];
