import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Attachment, Channel, Perm, has } from '../../core/api/models';
import { ToastService } from '../../core/ui/toast.service';

/** Mirrors the API allowlist (FileService): images re-encoded by the validator, plain text stored as-is. */
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT_RE = /\.(txt|log|md|csv|json)$/i;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_PER_MESSAGE = 10;
const POLL_MS = 1000;
const POLL_LIMIT_MS = 3 * 60_000;

interface FileStatus extends Attachment {
  state: 'pending' | 'ready' | 'rejected' | 'deleted';
  rejectReason: string | null;
}

export interface PendingUpload {
  key: string;
  channelId: string;
  name: string;
  size: number;
  isImage: boolean;
  progress: number;
  state: 'uploading' | 'processing' | 'ready' | 'failed';
  error?: string;
  attachment?: Attachment;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Composer attachments per channel (provided by TextChannelPage): uploads to the server's quarantine, then polls the
 * file status until the validator has normalized it. A message can only be sent once every chip is ready.
 */
@Injectable()
export class AttachmentUploads {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  private readonly all = signal<PendingUpload[]>([]);
  private readonly cancelled = new Set<string>();

  readonly byChannel = computed(() => {
    const map = new Map<string, PendingUpload[]>();
    for (const u of this.all()) map.set(u.channelId, [...(map.get(u.channelId) ?? []), u]);
    return map;
  });

  list(channelId: string): PendingUpload[] {
    return this.byChannel().get(channelId) ?? [];
  }

  canAttach(channel: Channel): boolean {
    return has(channel.permissions, Perm.SendMessages | Perm.AttachFiles);
  }

  add(channel: Channel, files: File[]): void {
    if (!files.length) return;
    if (!this.canAttach(channel)) {
      this.toast.show('You cannot attach files in this channel.', 'danger');
      return;
    }
    let room = MAX_PER_MESSAGE - this.list(channel.id).length;
    for (const file of files) {
      const isImage = IMAGE_RE.test(file.name);
      if (!isImage && !TEXT_RE.test(file.name)) {
        this.toast.show(`${file.name}: only images and plain text files can be shared.`, 'danger');
        continue;
      }
      if (file.size > (isImage ? MAX_IMAGE : MAX_TEXT)) {
        this.toast.show(`${file.name} is larger than ${formatSize(isImage ? MAX_IMAGE : MAX_TEXT)}.`, 'danger');
        continue;
      }
      if (room-- <= 0) {
        this.toast.show(`Up to ${MAX_PER_MESSAGE} files per message.`, 'danger');
        break;
      }
      const u: PendingUpload = { key: crypto.randomUUID(), channelId: channel.id, name: file.name, size: file.size, isImage, progress: 0, state: 'uploading' };
      this.all.update((l) => [...l, u]);
      void this.run(channel.serverId, u.key, file);
    }
  }

  remove(key: string): void {
    this.cancelled.add(key);
    this.all.update((l) => l.filter((u) => u.key !== key));
  }

  /** True while any chip in the channel is still uploading or being validated. */
  busy(channelId: string): boolean {
    return this.list(channelId).some((u) => u.state === 'uploading' || u.state === 'processing');
  }

  /** Ready attachments (failed chips block sending until removed); removes them from the tray. */
  take(channelId: string): Attachment[] | null {
    const list = this.list(channelId);
    if (list.some((u) => u.state !== 'ready')) return null;
    this.all.update((l) => l.filter((u) => u.channelId !== channelId));
    return list.map((u) => u.attachment!);
  }

  /** Puts attachments back after a permanently rejected send so the user does not lose them. */
  restore(channelId: string, attachments: Attachment[]): void {
    const back = attachments.map<PendingUpload>((a) => ({
      key: crypto.randomUUID(), channelId, name: a.name, size: a.size, isImage: a.mime.startsWith('image/'), progress: 100, state: 'ready', attachment: a,
    }));
    this.all.update((l) => [...l, ...back]);
  }

  private patch(key: string, change: Partial<PendingUpload>): void {
    this.all.update((l) => l.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }

  private async run(serverId: string, key: string, file: File): Promise<void> {
    const form = new FormData();
    form.append('file', file, file.name);
    let status: FileStatus;
    try {
      status = await this.api.upload<FileStatus>(`/servers/${serverId}/attachments`, form, (p) => this.patch(key, { progress: p }));
    } catch (e) {
      this.patch(key, { state: 'failed', error: ApiError.from(e).message });
      return;
    }
    if (this.cancelled.has(key)) return;
    this.patch(key, { state: 'processing', progress: 100 });
    const started = Date.now();
    while (status.state === 'pending' && Date.now() - started < POLL_LIMIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (this.cancelled.has(key)) return;
      try {
        status = await this.api.get<FileStatus>(`/files/${status.id}/status`);
      } catch {
        // transient: keep polling until the limit
      }
    }
    if (this.cancelled.has(key)) return;
    if (status.state === 'ready') {
      const { id, name, mime, size, width, height } = status;
      this.patch(key, { state: 'ready', name, attachment: { id, name, mime, size, width, height } });
    } else {
      this.patch(key, { state: 'failed', error: status.state === 'pending' ? 'Processing timed out.' : 'This file could not be processed.' });
    }
  }
}
