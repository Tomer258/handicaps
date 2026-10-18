import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api/api.service';
import { ApiError } from '../../core/api/api-error';
import { Member, Perm, Role, has } from '../../core/api/models';
import { SessionService } from '../../core/auth/session.service';
import { ToastService } from '../../core/ui/toast.service';
import { avatarColor, initials } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';

/** Server administration: who is here, their roles, removal. Locked rows/chips follow the role hierarchy. */
@Component({
  selector: 'hx-members-section',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 8px; font-size: 26px">Members</h2>
    <p style="margin: 0 0 16px; font-size: 13px; color: var(--tx3)">
      Click a role to give or take it. You can change members whose highest role is below yours, using roles below your own.
    </p>
    <input class="inp" type="search" placeholder="Search members" aria-label="Search members" [value]="query()" (input)="query.set($any($event.target).value)"
           style="margin-bottom: 8px" />

    @for (m of members(); track m.userId) {
      <div class="srow" style="align-items: center" [style.opacity]="store.canManageMember(m) ? 1 : 0.75">
        <div style="display: flex; align-items: center; gap: 10px; min-width: 0">
          <span class="av s32" [style.background]="color(m.avatarHue)">{{ ini(m.displayName) }}</span>
          <div style="min-width: 0"><div class="t" dir="auto">{{ m.displayName }}{{ m.userId === me() ? ' (you)' : '' }}</div>
            <div class="d mono">&#64;{{ m.login }}{{ m.isOwner ? ' · owner' : '' }}</div></div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end">
          @for (r of roles(); track r.id) {
            @if (m.roleIds.includes(r.id) || (store.canManageMember(m) && store.canManageRole(r))) {
              <button class="cat" [attr.aria-pressed]="m.roleIds.includes(r.id)" (click)="toggleRole(m, r)"
                      [disabled]="!store.canManageMember(m) || !store.canManageRole(r)"
                      [attr.aria-label]="r.name + ' role for ' + m.displayName" [title]="lockReason(m, r)">
                <span style="width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px" [style.background]="r.color || 'var(--tx3)'"></span>{{ r.name }}
              </button>
            }
          }
          @if (!store.canManageMember(m) && !m.isOwner) {
            <span title="Their highest role is not below yours" style="color: var(--tx3); display: inline-flex"><hx-icon name="lock" size="sm" /></span>
          }
          @if (canRemove() && !m.isOwner && m.userId !== me() && store.canManageMember(m)) {
            <button class="ibtn" style="width: 28px; height: 28px; color: var(--danger)" [attr.aria-label]="'Remove ' + m.displayName + ' from the server'"
                    title="Remove from server" (click)="remove(m)"><hx-icon name="trash" size="sm" /></button>
          }
        </div>
      </div>
    } @empty {
      <div style="font-size: 12.5px; color: var(--tx3); padding: 8px 0">No members match.</div>
    }
  `,
})
export class MembersSection {
  private readonly api = inject(ApiService);
  readonly store = inject(WorkspaceStore);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);

  readonly me = this.session.userId;
  readonly query = signal('');
  readonly canRemove = computed(() => has(this.store.myPermissions(), Perm.Administrator));
  readonly roles = computed(() => [...(this.store.server()?.roles ?? [])].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position));
  readonly members = computed(() => {
    const q = this.query().trim().toLowerCase();
    return [...this.store.memberById().values()]
      .filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.login.toLowerCase().includes(q))
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || this.store.topPositionOf(b) - this.store.topPositionOf(a) || a.displayName.localeCompare(b.displayName));
  });

  color(h: number): string {
    return avatarColor(h);
  }

  ini(n: string): string {
    return initials(n);
  }

  lockReason(m: Member, r: Role): string {
    if (m.isOwner) return 'The owner always has every permission';
    if (!this.store.canManageMember(m)) return 'Their highest role is not below yours';
    if (!this.store.canManageRole(r)) return 'This role is not below your highest role';
    return '';
  }

  async toggleRole(m: Member, r: Role): Promise<void> {
    const next = m.roleIds.includes(r.id) ? m.roleIds.filter((x) => x !== r.id) : [...m.roleIds, r.id];
    try {
      await this.api.put(`/servers/${this.store.serverId()}/members/${m.userId}/roles`, { roleIds: next.filter((id) => this.roles().some((a) => a.id === id)) });
      this.store.patchMember(m.userId, { roleIds: next });
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }

  async remove(m: Member): Promise<void> {
    if (!confirm(`Remove ${m.displayName} from the server? They will need a new invite to come back.`)) return;
    try {
      await this.api.delete(`/servers/${this.store.serverId()}/members/${m.userId}`);
      await this.store.reload();
    } catch (e) {
      this.toast.show(ApiError.from(e).message, 'danger');
    }
  }
}
