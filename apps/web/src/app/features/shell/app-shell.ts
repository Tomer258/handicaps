import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';
import { MediaSessionService } from '../../core/media/media-session.service';
import { ToastService } from '../../core/ui/toast.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Icon } from '../../shared/ui/icon';
import { LayoutService } from './layout.service';
import { ToastHost } from './toast-host';
import { Notifier } from '../notifications/notifier.service';
import { ChatStore } from '../messages/chat.store';
import { VoicePresenceStore } from '../voice/voice-presence.store';

/**
 * Top-level authenticated layout: server rail + routed content + toasts + session recovery.
 * Root media/voice services live outside routed components so text navigation never ends a call.
 */
@Component({
  selector: 'hx-app-shell',
  imports: [RouterOutlet, RouterLink, Icon, ToastHost],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <a class="skip-link" href="#composer">Skip to message composer</a>
    <div class="app" [class.nav-open]="layout.navOpen()">
      <nav class="rail" aria-label="Servers"
           style="width: 68px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; background: var(--bg0)">
        <a class="srv" [class.on]="atHome()" routerLink="/" aria-label="Home" title="Home"
           style="background: var(--accent); color: var(--accent-ink)">
          <span class="pip"></span>
          <hx-icon name="home" size="lg" />
        </a>
        <div style="width: 28px; height: 2px; border-radius: 1px; background: var(--line)"></div>
        <div role="list" style="display: flex; flex-direction: column; gap: 10px; align-items: center">
          @for (s of session.servers(); track s.id) {
            <a role="listitem" class="srv" [class.on]="store.serverId() === s.id && !atHome()" [routerLink]="['/s', s.id]"
               [attr.aria-label]="s.name" [title]="s.name" style="background: #23262C; color: #ECEEF1">
              <span class="pip"></span>
              <span class="disp" style="font-size: 15px; font-weight: 700">{{ short(s.name) }}</span>
            </a>
          }
        </div>
        <div style="flex: 1"></div>
      </nav>

      <div style="flex: 1; min-width: 0; display: flex; position: relative">
        <router-outlet />
      </div>

      <hx-toast-host />

      @if (session.expired()) {
        <div class="scrim" role="alertdialog" aria-modal="true" aria-labelledby="expired-title">
          <div class="pop fade" style="width: 400px; max-width: calc(100% - 32px); padding: 22px; display: flex; flex-direction: column; gap: 12px">
            <h2 id="expired-title" class="disp" style="margin: 0; font-size: 20px">Signed out</h2>
            <p style="margin: 0; color: var(--tx2)">Your session ended (expired or revoked from another device). Sign in again to continue.</p>
            <button class="btn pri" (click)="session.recoverToLogin()" cdkFocusInitial>Sign in</button>
          </div>
        </div>
      }
    </div>
  `,
})
export class AppShell {
  readonly session = inject(SessionService);
  readonly store = inject(WorkspaceStore);
  /** Eager: starts realtime + unread tracking for the session, independent of the routed view. */
  private readonly chat = inject(ChatStore);
  private readonly notifier = inject(Notifier);
  private readonly voiceRoster = inject(VoicePresenceStore);
  readonly layout = inject(LayoutService);
  private readonly media = inject(MediaSessionService);
  private readonly toast = inject(ToastService);

  readonly atHome = computed(() => this.store.serverId() === null);

  /** Global shortcuts (also while typing): Ctrl+Shift+M mute, Ctrl+Shift+D deafen; Esc closes the drawer / member overlay. */
  onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyM' || e.code === 'KeyD')) {
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'KeyM') void this.media.toggleMute().then(() => this.toast.show(this.media.muted() ? 'Microphone muted' : 'Microphone unmuted'));
      else void this.media.toggleDeafen().then(() => this.toast.show(this.media.deafened() ? 'Deafened' : 'Undeafened'));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK' && this.store.serverId()) {
      e.preventDefault();
      this.layout.searchOpen.update((open) => !open);
      return;
    }
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.scrim, .cdk-overlay-pane')) {
      if (this.layout.navOpen()) this.layout.navOpen.set(false);
      else if (this.layout.membersOverlay() && this.layout.membersOpen()) this.layout.membersOpen.set(false);
    }
  }

  short(name: string): string {
    const words = name.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : (words[0]?.[0] ?? '?').toUpperCase();
  }
}
