import { LucideIcon } from "lucide-react";

/**
 * The "nothing to show" card.
 *
 * `bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500`
 * was already the most common spelling; the outliers were a `p-10` dashed
 * variant on the offerings dashboard and a handful of bare `<p>`s. `children`
 * rather than a string prop because several call sites need a link in the
 * message ("Add requirements in Admin › Program Data").
 */
export default function EmptyState({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
      {Icon && <Icon className="mx-auto mb-2 text-gray-400" size={28} />}
      {children}
    </div>
  );
}
