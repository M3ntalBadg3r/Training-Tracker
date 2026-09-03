/**
 * Nav-refresh signal.
 *
 * The Sidebar's Offerings submenu is fetched from `/api/offerings` and otherwise
 * only re-fetches when the header company changes — so creating, renaming,
 * deleting or importing offerings left the nav showing a stale list until the
 * next company switch or page reload. Admin pages fire this event after such a
 * mutation and the Sidebar re-fetches.
 *
 * A window event (rather than context state) because the Sidebar is rendered
 * twice by AppShell — the desktop rail and the mobile drawer — and both need to
 * hear it; it is also the pattern the sidebar collapse toggle already uses.
 */
export const OFFERINGS_CHANGED_EVENT = "tt-offerings-changed";

export function notifyOfferingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OFFERINGS_CHANGED_EVENT));
}
