/**
 * The filter card that sits directly under the page header.
 *
 * Reports used to put their controls in one of four places — inside the table
 * card (7 pages), in a bare un-carded row above the KPI strip (3), in the chart
 * card's header (1), and in a card of its own (1). Only the last is honest:
 * these filters re-drive the KPI strip and every chart as well as the table, so
 * nesting them inside the table card tells the user they scope only the table.
 *
 * `FilterBar.Row` exists so a page with many controls can break them over
 * several lines without each page inventing its own gap and wrap rules.
 */
export default function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Filters"
      className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex flex-col gap-3"
    >
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

FilterBar.Row = Row;
