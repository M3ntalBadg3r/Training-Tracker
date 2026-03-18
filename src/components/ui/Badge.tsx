interface BadgeProps {
  active: boolean;
}

export default function Badge({ active }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        active
          ? "bg-green-100 text-green-800"
          : "bg-red-100 text-red-800"
      }`}
    >
      {active ? "Yes" : "No"}
    </span>
  );
}
