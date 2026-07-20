"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import Sidebar from "@/components/layout/Sidebar";
import CompanySwitcher from "@/components/company/CompanySwitcher";
import IdleTimeoutManager from "@/components/auth/IdleTimeoutManager";

const NO_SHELL_PATHS = ["/login", "/setup", "/setup-mfa"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = NO_SHELL_PATHS.some((p) => pathname.startsWith(p));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close the mobile drawer whenever the route changes (i.e. a nav link was
  // tapped). Done with React's "adjust state while rendering" pattern (tracking
  // the previous pathname) instead of a setState-in-effect. This fires on real
  // navigation but not on submenu-toggle clicks.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (mobileNavOpen) setMobileNavOpen(false);
  }

  if (isPublicPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-dvh">
      <IdleTimeoutManager />

      {/* Desktop rail — self-hides below md */}
      <Sidebar />

      {/* Mobile off-canvas drawer backdrop — always mounted, faded via opacity.
          Mounting/unmounting a full-viewport fixed overlay leaves a stuck dark
          tint over the browser toolbar safe-areas on iOS Safari, so we keep it
          in the DOM and toggle opacity + pointer-events instead. It's also
          sized to the dynamic viewport (top-0 + h-dvh rather than inset-0) so it
          never paints behind the mobile browser's bottom toolbar — that
          toolbar-occluded strip is what stayed dark at the bottom after close. */}
      <div
        className={`fixed inset-x-0 top-0 h-dvh z-40 bg-black/50 md:hidden transition-opacity duration-300 ${
          mobileNavOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />
      <div
        className={`fixed top-0 left-0 h-dvh z-50 md:hidden transition-transform duration-300 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar mobile onClose={() => setMobileNavOpen(false)} />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 px-4 sm:px-6 py-2 bg-white border-b border-gray-200">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors md:hidden"
            title="Open menu"
            aria-label="Open navigation menu"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-4 ml-auto">
            <CompanySwitcher />
          </div>
        </header>
        <main className="flex-1 overflow-auto bg-gray-50 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
