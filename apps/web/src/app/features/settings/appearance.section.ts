import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Accent, PreferencesService } from '../../core/ui/preferences.service';

/** Appearance (synced to the account through UserSettingsService). */
@Component({
  selector: 'hx-appearance-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="disp" style="margin: 0 0 20px; font-size: 26px">Appearance</h2>
    <div class="srow"><div><div class="t">Theme</div><div class="d">Dark is tuned for long sessions on a second monitor</div></div>
      <div class="seg" role="group" aria-label="Theme">
        <button [attr.aria-pressed]="a().theme === 'dark'" (click)="prefs.update({ theme: 'dark' })">Dark</button>
        <button [attr.aria-pressed]="a().theme === 'light'" (click)="prefs.update({ theme: 'light' })">Light</button>
      </div></div>
    <div class="srow"><div><div class="t">Accent color</div><div class="d">Used for speaking rings, focus and primary actions</div></div>
      <div style="display: flex; gap: 8px" role="radiogroup" aria-label="Accent color">
        @for (o of accents; track o.id) {
          <button role="radio" [attr.aria-label]="o.label" [attr.aria-checked]="a().accent === o.id" (click)="prefs.update({ accent: o.id })"
                  style="width: 30px; height: 30px; border-radius: 50%" [style.background]="o.color"
                  [style.box-shadow]="a().accent === o.id ? '0 0 0 2px var(--bg1), 0 0 0 4px ' + o.color : null"></button>
        }
      </div></div>
    <div class="srow"><div><div class="t">Message text size</div><div class="d">{{ a().fontScale }}%</div></div>
      <input type="range" class="rng" min="85" max="125" step="5" [value]="a().fontScale" (input)="prefs.update({ fontScale: +$any($event.target).value })"
             aria-label="Message text size" style="max-width: 240px" /></div>
    <div class="srow"><div><div class="t">Message density</div><div class="d">Compact hides avatars and fits more chat on screen</div></div>
      <div class="seg" role="group" aria-label="Message density">
        <button [attr.aria-pressed]="a().density === 'cozy'" (click)="prefs.update({ density: 'cozy' })">Cozy</button>
        <button [attr.aria-pressed]="a().density === 'compact'" (click)="prefs.update({ density: 'compact' })">Compact</button>
      </div></div>
    <div class="srow"><div><div class="t">Reduce motion</div><div class="d">Turns off speaking pulses, waveforms and stream drift</div></div>
      <button class="sw" aria-label="Reduce motion" [attr.aria-pressed]="a().reduceMotion" (click)="prefs.update({ reduceMotion: !a().reduceMotion })"></button></div>
  `,
})
export class AppearanceSection {
  readonly prefs = inject(PreferencesService);
  readonly a = this.prefs.appearance;
  readonly accents: { id: Accent; label: string; color: string }[] = [
    { id: 'volt', label: 'Volt', color: '#C8F05A' },
    { id: 'glacier', label: 'Glacier', color: '#5CE1E6' },
    { id: 'ember', label: 'Ember', color: '#FF8A65' },
    { id: 'iris', label: 'Iris', color: '#A78BFA' },
  ];
}
