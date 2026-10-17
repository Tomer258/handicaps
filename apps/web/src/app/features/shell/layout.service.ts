import { Injectable, signal } from '@angular/core';

/** UI layout toggles shared by header buttons and the shell (members aside, theater, mobile drawer). */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly membersOpen = signal(true);
  readonly theater = signal(false);
  readonly navOpen = signal(false);
}
