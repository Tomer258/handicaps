import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PreferencesService } from './core/ui/preferences.service';
import { UserSettingsService } from './core/settings/user-settings.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class App {
  // Instantiated at boot so theme/accent/reduced-motion apply before the first route renders.
  private readonly prefs = inject(PreferencesService);
  // Loads server-synced settings after sign-in (status, notifications, appearance).
  private readonly settings = inject(UserSettingsService);
}
