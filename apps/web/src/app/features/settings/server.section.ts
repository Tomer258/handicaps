import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { ServerDetail } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { ToastService } from '../../core/ui/toast.service';
import { serverIconUrl, short } from '../../shared/ui/server-icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Server administration (Administrator): name, icon, where "X joined" messages go. */
@Component({
  selector: 'hx-server-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Server</h2>

    <div class="card" style="display: flex; gap: 18px; align-items: center; flex-wrap: wrap">
      <span aria-hidden="true" data-testid="server-icon-preview"
            style="width: 72px; height: 72px; border-radius: 22px; background: #23262C; color: #ECEEF1; overflow: hidden; flex: none; display: grid; place-items: center">
        @if (iconSrc(); as u) { <img [src]="u" alt="" style="width: 100%; height: 100%; object-fit: cover" /> }
        @else { <span class="disp" style="font-size: 24px; font-weight: 700">{{ initials() }}</span> }
      </span>
      <div style="flex: 1; min-width: 200px">
        <div class="t" style="font-weight: 600">Server icon</div>
        <div style="font-size: 12.5px; color: var(--tx3)">PNG, JPEG, GIF or WebP up to 5 MB. Cropped to a square.</div>
        @if (iconState(); as st) { <div role="status" style="font-size: 12px; color: var(--tx3); margin-top: 4px">{{ st }}</div> }
      </div>
      <div style="display: flex; gap: 8px">
        @if (server()?.iconAssetId) {
          <button class="btn ghost" (click)="removeIcon()" [disabled]="iconBusy()">Remove</button>
        }
        <button class="btn sec" (click)="iconInput.click()" [disabled]="iconBusy()">Upload icon</button>
        <input #iconInput type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" (change)="onIconPick($event)" data-testid="server-icon-input" />
      </div>
    </div>

    <div class="field" style="margin-top: 18px">
      <label for="srv-name">Server name</label>
      <div style="display: flex; gap: 8px">
        <input id="srv-name" class="inp" maxlength="48" dir="auto" style="flex: 1" [value]="name()" (input)="name.set($any($event.target).value)"
               (keydown.enter)="saveName()" />
        <button class="btn pri" (click)="saveName()" [disabled]="busy() || !nameChanged()">Save</button>
      </div>
    </div>

    <div class="lbl" style="margin: 26px 0 4px">Join messages</div>
    <div class="srow">
      <div><div class="t">Say when someone joins</div><div class="d">Posts "… joined" so friends can wave hello</div></div>
      <button class="sw" [attr.aria-pressed]="server()?.joinMessages !== false" aria-label="Say when someone joins"
              (click)="patch({ joinMessages: server()?.joinMessages === false })" [disabled]="busy()"></button>
    </div>
    @if (server()?.joinMessages !== false) {
      <div class="field" style="margin-top: 10px">
        <label for="srv-join">Post them in</label>
        <select id="srv-join" class="inp" (change)="pickJoinChannel($any($event.target).value)" [disabled]="busy()">
          <option value="" [selected]="!server()?.joinMessageChannelId">Automatic — the first text channel the newcomer can see</option>
          @for (c of textChannels(); track c.id) {
            <option [value]="c.id" [selected]="c.id === server()?.joinMessageChannelId"># {{ c.name }}</option>
          }
        </select>
      </div>
    }
  `,
})
export class ServerSection {
  private readonly api = inject(ApiService);
  private readonly store = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);

  readonly server = this.store.server;
  readonly textChannels = computed(() => this.store.channels().filter((c) => c.type === 'text'));
  readonly name = signal('');
  readonly busy = signal(false);
  readonly iconBusy = signal(false);
  readonly iconState = signal('');
  readonly nameChanged = computed(() => this.name().trim().length > 0 && this.name().trim() !== this.server()?.name);
  readonly iconSrc = computed(() => serverIconUrl(this.server()?.iconAssetId));
  readonly initials = computed(() => short(this.server()?.name ?? ''));

  constructor() {
    // Follow the server name (including a rename by another admin) until the field is edited.
    let shown = '';
    effect(() => {
      const n = this.server()?.name ?? '';
      if (this.name() === shown) this.name.set(n);
      shown = n;
    });
  }

  async saveName(): Promise<void> {
    if (!this.nameChanged()) return;
    if (await this.patch({ name: this.name().trim() })) this.toast.show('Server renamed', 'info');
  }

  pickJoinChannel(id: string): void {
    void this.patch(id ? { joinMessageChannelId: id } : { clearJoinMessageChannel: true });
  }

  async patch(body: Record<string, unknown>): Promise<boolean> {
    const id = this.store.serverId();
    if (!id) return false;
    this.busy.set(true);
    try {
      await this.api.patch<ServerDetail>(`/servers/${id}`, body);
      await this.refresh();
      return true;
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async onIconPick(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const id = this.store.serverId();
    if (!file || !id) return;
    if (file.size > 5 * 1024 * 1024) {
      this.toast.show('Icons can be up to 5 MB.', 'danger');
      return;
    }
    const form = new FormData();
    form.append('file', file, file.name);
    this.iconBusy.set(true);
    this.iconState.set('Uploading…');
    try {
      let st = await this.api.upload<{ id: string; state: string }>(`/servers/${id}/icon`, form, (p) => this.iconState.set(`Uploading… ${p}%`));
      this.iconState.set('Processing…');
      for (let i = 0; i < 180 && st.state === 'pending'; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        st = await this.api.get<{ id: string; state: string }>(`/files/${st.id}/status`);
      }
      if (st.state !== 'ready') throw new Error(st.state === 'pending' ? 'Processing timed out.' : 'That image could not be used.');
      // serverUpdated usually arrives first; refresh anyway so the change shows without realtime.
      await this.refresh();
      this.toast.show('Server icon updated', 'info');
    } catch (err) {
      this.toast.show(err instanceof ApiError ? err.message : (err as Error).message, 'danger');
    } finally {
      this.iconBusy.set(false);
      this.iconState.set('');
    }
  }

  async removeIcon(): Promise<void> {
    const id = this.store.serverId();
    if (!id) return;
    this.iconBusy.set(true);
    try {
      await this.api.delete(`/servers/${id}/icon`);
      await this.refresh();
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    } finally {
      this.iconBusy.set(false);
    }
  }

  private async refresh(): Promise<void> {
    await Promise.all([this.store.reload(), this.session.refreshMe()]);
  }
}
