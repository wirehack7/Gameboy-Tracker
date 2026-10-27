type EventData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: { track(event: string, data?: EventData): void };
  }
}

/**
 * Sends a custom event to Umami. Does nothing when the tracker is not loaded
 * (local builds, Do Not Track, blockers, offline) and never throws.
 */
export function track(event: string, data?: EventData) {
  try {
    const umami = typeof window === 'undefined' ? undefined : window.umami;
    if (typeof umami?.track === 'function') umami.track(event, data);
  } catch {
    // Analytics must never break the tracker.
  }
}
