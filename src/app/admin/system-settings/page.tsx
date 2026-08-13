"use client";

import { useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import BrandingSection from "./BrandingSection";
import DateFormatSection from "./DateFormatSection";
import ImportAliasesSection from "./ImportAliasesSection";
import SessionSection from "./SessionSection";

// Tab order = display order. A map rather than a ternary chain: at four tabs a
// nested conditional stops being readable, and this keeps label and section
// defined together.
const TABS = {
  dateFormat: { label: "Date Format", render: () => <DateFormatSection /> },
  session: { label: "Session", render: () => <SessionSection /> },
  importAliases: { label: "Import Aliases", render: () => <ImportAliasesSection /> },
  branding: { label: "Branding", render: () => <BrandingSection /> },
} as const;

type Tab = keyof typeof TABS;

export default function SystemSettingsPage() {
  const [tab, setTab] = useState<Tab>("dateFormat");

  return (
    <div>
      <PageHeader title="System Settings" showBack helpSlug="system-settings" />

      <div className="max-w-3xl">
        <div className="border-b border-gray-200 mb-6 flex gap-1">
          {(Object.keys(TABS) as Tab[]).map((key) => (
            <TabButton key={key} active={tab === key} onClick={() => setTab(key)}>
              {TABS[key].label}
            </TabButton>
          ))}
        </div>

        {TABS[tab].render()}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-blue-600 text-blue-700"
          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
      }`}
    >
      {children}
    </button>
  );
}
