import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Role, has } from '../../core/api/models';
import { ToastService } from '../../core/ui/toast.service';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { PERM_GROUPS } from './perm-groups';

const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];

/** Server administration: create, edit, reorder and delete roles. Everything respects the role hierarchy. */
@Component({
  selector: 'hx-roles-section',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="display: flex; align-items: center; gap: 12px; margin: 0 0 8px">
      <h2 class="disp" style="margin: 0; font-size: 26px; flex: 1">Roles</h2>
      <button class="btn pri" (click)="create()" [disabled]="busy()"><hx-icon name="plus" size="sm" />Create role</button>
    </div>
    <div class="note" style="margin: 0 0 16px; font-size: 12.5px">
      <hx-icon name="shield" size="sm" />
      <div>Roles higher in the list outrank lower ones. Members get every permission of every role they have, plus &#64;everyone.
        You can edit roles <b>below</b> your highest role and grant only permissions you have yourself. The owner can do everything.</div>
    </div>

    @for (r of roles(); track r.id; let i = $index) {
      <div class="card" style="margin-top: 8px; padding: 0" [attr.data-role]="r.name">
        <div style="display: flex; align-items: center; gap: 4px; padding-right: 8px">
          <button style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 12px 16px; text-align: left"
                  (click)="openRole.set(openRole() === r.id ? null : r.id)" [attr.aria-expanded]="openRole() === r.id">
            <span style="width: 10px; height: 10px; border-radius: 50%; flex: none" [style.background]="r.color || 'var(--tx3)'"></span>
            <b style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" dir="auto">{{ r.isDefault ? '@everyone' : r.name }}</b>
            @if (!store.canManageRole(r)) { <span title="Not below your highest role" style="color: var(--tx3); display: inline-flex"><hx-icon name="lock" size="sm" /></span> }
            <span style="font-size: 12px; color: var(--tx3)">{{ memberCount(r) }} · {{ count(r.permissions) }} perms</span>
            <hx-icon [name]="openRole() === r.id ? 'chevron-down' : 'chevron-right'" size="sm" />
          </button>
          @if (!r.isDefault) {
            <button class="ibtn" style="width: 28px; height: 28px" [attr.aria-label]="'Move ' + r.name + ' up'" title="Move up"
                    [disabled]="!canMove(i, -1)" (click)="move(i, -1)"><span style="display: inline-flex; transform: rotate(180deg)"><hx-icon name="chevron-down" size="sm" /></span></button>
            <button class="ibtn" style="width: 28px; height: 28px" [attr.aria-label]="'Move ' + r.name + ' down'" title="Move down"
                    [disabled]="!canMove(i, 1)" (click)="move(i, 1)"><hx-icon name="chevron-down" size="sm" /></button>
          }
        </div>
        @if (openRole() === r.id) {
          @let locked = !store.canManageRole(r);
          <div style="padding: 0 16px 14px">
            @if (locked) {
              <div style="font-size: 12.5px; color: var(--tx3); margin-bottom: 8px">This role is at or above your highest role, so you can only look at it.</div>
            }
            @if (!r.isDefault) {
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; align-items: end">
                <div class="field"><label [for]="'rn-' + r.id">Name</label>
                  <input class="inp" [id]="'rn-' + r.id" maxlength="32" dir="auto" [value]="r.name" [disabled]="locked"
                         (change)="patch(r, { name: $any($event.target).value })" /></div>
                <div class="field"><span class="lbl" style="margin: 0">Color</span>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap; padding: 6px 0" role="radiogroup" [attr.aria-label]="r.name + ' color'">
                    <button class="swatch" role="radio" [attr.aria-checked]="!r.color" aria-label="No color" [disabled]="locked" (click)="patch(r, { color: '' })"
                            style="background: var(--tx3)"></button>
                    @for (c of colors; track c) {
                      <button class="swatch" role="radio" [attr.aria-checked]="r.color === c" [attr.aria-label]="c" [disabled]="locked" (click)="patch(r, { color: c })"
                              [style.background]="c"></button>
                    }
                  </div></div>
              </div>
              <label style="display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; cursor: pointer">
                <input type="checkbox" [checked]="r.hoist" [disabled]="locked" (change)="patch(r, { hoist: !r.hoist })" />Show members with this role separately in the member list
              </label>
            }
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px 18px">
              @for (g of groups; track g.label) {
                <div><div class="lbl" style="margin: 10px 0 4px">{{ g.label }}</div>
                  @for (p of g.perms; track p.bit) {
                    <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer"
                           [style.opacity]="locked || (!hasBit(r.permissions, p.bit) && !store.canGrant(p.bit)) ? 0.55 : 1"
                           [title]="!hasBit(r.permissions, p.bit) && !store.canGrant(p.bit) ? 'You cannot grant a permission you do not have' : ''">
                      <input type="checkbox" [checked]="hasBit(r.permissions, p.bit)" (change)="toggleBit(r, p.bit)"
                             [disabled]="locked || (!hasBit(r.permissions, p.bit) && !store.canGrant(p.bit))" />{{ p.label }}
                    </label>
                  }
                </div>
              }
            </div>
            @if (!r.isDefault && !locked) {
              <div style="display: flex; justify-content: flex-end; margin-top: 12px">
                <button class="btn ghost" style="color: var(--danger)" (click)="remove(r)"><hx-icon name="trash" size="sm" />Delete role</button>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: `
    .swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; }
    .swatch[aria-checked='true'] { border-color: var(--tx); box-shadow: 0 0 0 2px var(--bg1) inset; }
    .swatch:disabled { cursor: default; opacity: .6; }
  `,
})
export class RolesSection {
  private readonly api = inject(ApiService);
  readonly store = inject(WorkspaceStore);
  private readonly toast = inject(ToastService);

  readonly groups = PERM_GROUPS;
  readonly colors = COLORS;
  readonly busy = signal(false);
  readonly openRole = signal<string | null>(null);
  readonly roles = computed(() => [...(this.store.server()?.roles ?? [])].sort((a, b) => b.position - a.position));

  hasBit(mask: number, bit: number): boolean {
    return has(mask, bit);
  }

  count(mask: number): number {
    return PERM_GROUPS.flatMap((g) => g.perms).filter((p) => has(mask, p.bit)).length;
  }

  memberCount(r: Role): string {
    if (r.isDefault) return 'everyone';
    const n = [...this.store.memberById().values()].filter((m) => m.roleIds.includes(r.id)).length;
    return n === 1 ? '1 member' : `${n} members`;
  }

  /** Roles swap only with a neighbour that is also manageable (and never with @everyone). */
  canMove(i: number, dir: -1 | 1): boolean {
    const list = this.roles();
    const a = list[i];
    const b = list[i + dir];
    return !!a && !!b && !a.isDefault && !b.isDefault && this.store.canManageRole(a) && this.store.canManageRole(b);
  }

  async move(i: number, dir: -1 | 1): Promise<void> {
    if (!this.canMove(i, dir)) return;
    const list = this.roles();
    const [hi, lo] = dir === -1 ? [list[i], list[i - 1]] : [list[i + 1], list[i]];
    await this.run(() => this.api.put(`/servers/${this.store.serverId()}/roles/order`, { roleIds: [hi.id, lo.id] }));
  }

  async create(): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.post<Role>(`/servers/${this.store.serverId()}/roles`, { name: 'new role', permissions: 0 });
      await this.store.reload();
      this.openRole.set(r.id);
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  async patch(r: Role, body: { name?: string; color?: string; hoist?: boolean; permissions?: number }): Promise<void> {
    if (body.name !== undefined && !body.name.trim()) return;
    await this.run(() => this.api.patch(`/servers/${this.store.serverId()}/roles/${r.id}`, body));
  }

  async toggleBit(r: Role, bit: number): Promise<void> {
    await this.patch(r, { permissions: has(r.permissions, bit) ? r.permissions & ~bit : r.permissions | bit });
  }

  async remove(r: Role): Promise<void> {
    if (!confirm(`Delete the role "${r.name}"? Members lose it and its channel permissions are removed.`)) return;
    await this.run(() => this.api.delete(`/servers/${this.store.serverId()}/roles/${r.id}`));
    this.openRole.set(null);
  }

  private async run(call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
    await this.store.reload();
  }
}
