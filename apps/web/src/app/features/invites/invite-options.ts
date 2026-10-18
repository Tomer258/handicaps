export interface InviteSettings {
  lifetimeHours: number;
  maxUses: number;
  note: string;
}

/** Server limits (IdentityOptions): at most 14 days and 15 uses. */
export const INVITE_LIFETIMES = [
  { hours: 1, label: '1 hour' }, { hours: 24, label: '1 day' }, { hours: 168, label: '7 days' }, { hours: 336, label: '14 days' },
];
export const INVITE_USES = [1, 5, 10, 15];
