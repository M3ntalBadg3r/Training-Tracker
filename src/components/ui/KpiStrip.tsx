"use client";

import { LucideIcon } from "lucide-react";

export interface KpiCard {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: "blue" | "green" | "amber" | "red" | "indigo" | "emerald";
  hint?: string;
}

const TONE: Record<NonNullable<KpiCard["tone"]>, { bg: string; icon: string }> = {
  blue: { bg: "bg-blue-50 text-blue-700", icon: "text-blue-500" },
  green: { bg: "bg-green-50 text-green-700", icon: "text-green-500" },
  amber: { bg: "bg-amber-50 text-amber-700", icon: "text-amber-500" },
  red: { bg: "bg-red-50 text-red-700", icon: "text-red-500" },
  indigo: { bg: "bg-indigo-50 text-indigo-700", icon: "text-indigo-500" },
  emerald: { bg: "bg-emerald-50 text-emerald-700", icon: "text-emerald-500" },
};

export default function KpiStrip({ cards }: { cards: KpiCard[] }) {
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {cards.map((c) => {
        const Icon = c.icon;
        const tone = TONE[c.tone ?? "blue"];
        return (
          <div
            key={c.label}
            className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-3"
          >
            <div className={`p-2.5 rounded-lg ${tone.bg}`}>
              <Icon size={20} className={tone.icon} />
            </div>
            <div className="min-w-0">
              <div className="text-xl font-bold text-gray-900">
                {typeof c.value === "number" ? c.value.toLocaleString() : c.value}
              </div>
              <div className="text-xs text-gray-500 truncate">{c.label}</div>
              {c.hint && <div className="text-xs text-gray-400 truncate">{c.hint}</div>}
            </div>
          </div>
        );
      })}
    </section>
  );
}
