import { Injectable, computed, signal } from '@angular/core';

/** Responsive.dc.html breakpoints. */
export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
const DOCK_KEY = 'hangar.soundboardDocked';
const QUERIES: [Breakpoint, string][] = [
  ['xl', '(min-width: 1600px)'],
  ['lg', '(min-width: 1280px)'],
  ['md', '(min-width: 1080px)'],
  ['sm', '(min-width: 820px)'],
];

/** UI layout toggles shared by header buttons and the shell (members aside, theater, mobile drawer). */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly breakpoint = signal<Breakpoint>(current());
  /** Below 1280 the member list is hidden by default and its toggle overlays the main view. */
  readonly membersOverlay = computed(() => this.breakpoint() === 'md' || this.breakpoint() === 'sm' || this.breakpoint() === 'xs');
  readonly mobile = computed(() => this.breakpoint() === 'xs');

  readonly membersOpen = signal(!this.membersOverlay());
  readonly theater = signal(false);
  readonly navOpen = signal(false);
  /** Server message search panel (Ctrl K). */
  readonly searchOpen = signal(false);
  /** Soundboard popover and Go-live dialog: opened from the call dock or the voice panel, shown on any page. */
  readonly soundboardOpen = signal(false);
  readonly shareOpen = signal(false);
  /** Soundboard Concept B: pinned to the side at ≥ 1280 (replaces the member list at lg, sits beside it at xl). */
  readonly soundboardPinned = signal(loadDocked());
  readonly canDockSoundboard = computed(() => this.breakpoint() === 'lg' || this.breakpoint() === 'xl');
  readonly soundboardDocked = computed(() => this.canDockSoundboard() && this.soundboardPinned());
  /** One stream at a time and no streaming out below 820 px (Responsive: mobile). */
  readonly singleStream = computed(() => this.breakpoint() === 'xs');
  /** A search hit to scroll to once its channel is open. */
  readonly jumpTarget = signal<{ channelId: string; messageId: string } | null>(null);

  constructor() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    for (const [, q] of QUERIES) window.matchMedia(q).addEventListener('change', () => this.update());
  }

  toggleSoundboardDock(): void {
    this.soundboardPinned.update((v) => !v);
    try {
      localStorage.setItem(DOCK_KEY, this.soundboardPinned() ? '1' : '0');
    } catch {
      /* storage unavailable: the choice lasts for this tab */
    }
  }

  private update(): void {
    const wasOverlay = this.membersOverlay();
    this.breakpoint.set(current());
    // Crossing the 1280 line resets the aside to that width's default; the drawer only exists on narrow windows.
    if (wasOverlay !== this.membersOverlay()) this.membersOpen.set(!this.membersOverlay());
    if (!this.mobile()) this.navOpen.set(false);
  }
}

function current(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'lg';
  return QUERIES.find(([, q]) => window.matchMedia(q).matches)?.[0] ?? 'xs';
}

function loadDocked(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) === '1';
  } catch {
    return false;
  }
}
