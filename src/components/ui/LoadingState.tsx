/**
 * The one loading indicator.
 *
 * Before this there were eight distinct `animate-spin` class strings and six
 * spellings of the label ("Loading report...", "Loading students...", bare
 * "Loading...", and "Loading…" with a real ellipsis). Only one of the eight
 * lived behind a component, and it sat in `components/programs/` — so the
 * report pages, which could not sensibly import from there, each pasted their
 * own. Everything now routes through here.
 *
 * `size` picks the vertical presence, not the spinner: "page" is a whole route
 * waiting on its first payload, "section" is one card inside a page that has
 * already rendered.
 */
export default function LoadingState({
  label = "Loading…",
  size = "page",
}: {
  label?: string;
  size?: "page" | "section";
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${
        size === "page" ? "h-64" : "py-8"
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
      <span className="text-sm text-gray-500">{label}</span>
    </div>
  );
}
