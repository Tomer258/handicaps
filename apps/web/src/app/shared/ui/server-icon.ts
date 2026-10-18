/** Server icon image (immutable asset id), or null to show initials. */
export function serverIconUrl(assetId: string | null | undefined): string | null {
  return assetId ? `/api/v1/server-icons/${assetId}` : null;
}

/** Rail initials: "The Hangar" → "H", "Night Owls" → "NO". */
export function short(name: string): string {
  const words = name.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
  return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : (words[0]?.[0] ?? '?').toUpperCase();
}
