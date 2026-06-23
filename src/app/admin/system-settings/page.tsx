"use client";

import { useState } from "react";
import PageHeader from "@/components/layout/PageHeader";
import DateFormatSection from "./DateFormatSection";
import ImportAliasesSection from "./ImportAliasesSection";

type Tab = "dateFormat" | "importAliases";

export default function SystemSettingsPage() {
  const [tab, setTab] = useState<Tab>("dateFormat");

  return (
    <div>
      <PageHeader title="System Settings" showBack helpSlug="system-settings" />

      <div className="max-w-3xl">
        <div className="border-b border-gray-200 mb-6 flex gap-1">
          <TabButton active={tab === "dateFormat"} onClick={() => setTab("dateFormat")}>
            Date Format
          </TabButton>
          <TabButton active={tab === "importAliases"} onClick={() => setTab("importAliases")}>
            Import Aliases
          </TabButton>
        </div>

        {tab === "dateFormat" ? <DateFormatSection /> : <ImportAliasesSection />}
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
