import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input } from '@angular/core';
import { ICONS, IconName } from './icons';

/** Inline stroke icon from the Hangar set. Decorative by default (aria-hidden). */
@Component({
  selector: 'hx-icon',
  template: `<svg viewBox="0 0 24 24" class="ic" [class.sm]="size() === 'sm'" [class.lg]="size() === 'lg'" aria-hidden="true"></svg>`,
  styles: `:host { display: contents; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Icons are static, trusted constants (never user content), so setting markup directly is safe.
    effect(() => {
      const svg = this.host.nativeElement.querySelector('svg');
      if (svg) svg.innerHTML = ICONS[this.name()];
    });
  }
}
