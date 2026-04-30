"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import CompanySwitcher from "@/components/company/CompanySwitcher";

const NO_SHELL_PATHS = ["/login", "/setup"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = NO_SHELL_PATHS.some((p) => pathname.startsWith(p));

  if (isPublicPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-end gap-4 px-6 py-2 bg-white border-b border-gray-200">
          <CompanySwitcher />
        </header>
        <main className="flex-1 overflow-auto bg-gray-50 p-6">{children}</main>
      </div>
    </div>
  );
}
