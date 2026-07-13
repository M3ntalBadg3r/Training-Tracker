"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  Upload,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Globe,
  BookOpen,
  FileBarChart,
  HardDrive,
  LogOut,
  User,
  UserCog,
  Sparkles,
  RefreshCw,
  Moon,
  Sun,
  CalendarClock,
  CalendarX,
  ClipboardList,
  ShieldCheck,
  Tag,
  BarChart2,
  Briefcase,
  Clock,
  CalendarDays,
  AlertCircle,
  Building2,
  TrendingUp,
  Scale,
  SlidersHorizontal,
  UserCheck,
  History,
  KeyRound,
  Award,
  Info,
  Package,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useTheme } from "@/components/theme/ThemeProvider";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/students", label: "Students", icon: Users },
  { href: "/training", label: "Training", icon: GraduationCap },
];

const adminSubItems: { href: string; label: string; icon: typeof Users; superAdminOnly?: boolean }[] = [
  { href: "/admin/users", label: "Users", icon: Users, superAdminOnly: true },
  { href: "/admin/companies", label: "Companies", icon: Building2, superAdminOnly: true },
  { href: "/admin/program-data", label: "Program Data", icon: ClipboardList, superAdminOnly: true },
  { href: "/admin/training-data", label: "Training Data", icon: BookOpen, superAdminOnly: true },
  { href: "/admin/product-types", label: "Product Types", icon: Tag, superAdminOnly: true },
  { href: "/admin/specialisations", label: "Specialisations", icon: Award, superAdminOnly: true },
  { href: "/admin/region-data", label: "Region Data", icon: Globe, superAdminOnly: true },
  { href: "/admin/system-settings", label: "System Settings", icon: SlidersHorizontal, superAdminOnly: true },
  { href: "/admin/api-keys", label: "API Keys", icon: KeyRound, superAdminOnly: true },
  { href: "/admin/cleanup", label: "Data Clean-Up", icon: Sparkles, superAdminOnly: true },
  { href: "/admin/backup", label: "Backup", icon: HardDrive, superAdminOnly: true },
  { href: "/admin/import", label: "Import", icon: Upload },
  { href: "/admin/scheduled-exports", label: "Scheduled Report Exports", icon: CalendarClock },
  { href: "/admin/updates", label: "Updates", icon: RefreshCw, superAdminOnly: true },
];

const reportSubItems = [
  { href: "/reports/by-product-type", label: "By Product Type", icon: BarChart2 },
  { href: "/reports/by-function", label: "By Function", icon: Briefcase },
  { href: "/reports/expiring-soon", label: "Expiring Soon", icon: Clock },
  { href: "/reports/expired", label: "Currently Expired", icon: CalendarX },
  { href: "/reports/last-12-months", label: "Achievement Over Time", icon: CalendarDays },
  { href: "/reports/trained-not-certified", label: "Trained Not Certified", icon: AlertCircle },
  { href: "/reports/learner-scorecard", label: "Learner Achievement Scorecard", icon: UserCheck },
  { href: "/reports/comparison", label: "Comparison", icon: Scale },
  { href: "/reports/legacy-gap", label: "Legacy Replacement Gap", icon: History },
  { href: "/reports/catalogue-health", label: "Catalogue Health", icon: BookOpen },
  { href: "/reports/program-compliance-trend", label: "Compliance Trend", icon: TrendingUp },
  { href: "/reports/renewal-forecast", label: "Renewal Forecast", icon: RefreshCw },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, isAdmin, logout } = useAuth();
  const isSuperAdmin = user?.role === "SuperAdmin";
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);
  const [programsOpen, setProgramsOpen] = useState(false);
  const [offeringsOpen, setOfferingsOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  // Programs submenu is data-driven — one entry per configured program.
  const [programSubItems, setProgramSubItems] = useState<{ href: string; label: string }[]>([]);
  // Offerings submenu is data-driven — one entry per configured offering.
  const [offeringSubItems, setOfferingSubItems] = useState<{ href: string; label: string }[]>([]);

  useEffect(() => {
    fetch("/api/programs")
      .then((r) => r.json())
      .then((d: { programs?: { name: string }[] }) => {
        setProgramSubItems(
          (d.programs || []).map((p) => ({
            href: `/programs/${encodeURIComponent(p.name)}`,
            label: p.name,
          }))
        );
      })
      .catch(() => {});
    fetch("/api/offerings")
      .then((r) => r.json())
      .then((d: { offerings?: { name: string }[] }) => {
        setOfferingSubItems(
          (d.offerings || []).map((o) => ({
            href: `/offerings/${encodeURIComponent(o.name)}`,
            label: o.name,
          }))
        );
      })
      .catch(() => {});
  }, []);

  const isAdminActive = pathname.startsWith("/admin");
  const isProgramsActive = pathname.startsWith("/programs");
  const isOfferingsActive = pathname.startsWith("/offerings");
  const isReportsActive = pathname === "/reports" || pathname.startsWith("/reports/");

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setCollapsed(stored === "true");
  }, []);

  // Auto-expand admin submenu when on an admin page
  useEffect(() => {
    if (isAdminActive) setAdminOpen(true);
  }, [isAdminActive]);

  // Auto-expand programs submenu when on a programs page
  useEffect(() => {
    if (isProgramsActive) setProgramsOpen(true);
  }, [isProgramsActive]);

  // Auto-expand offerings submenu when on an offerings page
  useEffect(() => {
    if (isOfferingsActive) setOfferingsOpen(true);
  }, [isOfferingsActive]);

  // Auto-expand reports submenu when on a reports sub-page
  useEffect(() => {
    if (isReportsActive) setReportsOpen(true);
  }, [isReportsActive]);

  const toggle = () => {
    setCollapsed((prev) => {
      localStorage.setItem("sidebar-collapsed", String(!prev));
      return !prev;
    });
  };

  return (
    <aside
      className={`sidebar-nav flex flex-col bg-slate-900 text-white transition-all duration-300 ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      <div className="shrink-0 flex items-center justify-between p-4 border-b border-slate-700">
        {!collapsed && (
          <h1 className="text-lg font-bold whitespace-nowrap">
            Training Tracker
          </h1>
        )}
        <button
          onClick={toggle}
          className="p-1 rounded hover:bg-slate-700 transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
        </button>
      </div>
      <nav className="flex-1 min-h-0 overflow-y-auto py-4">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                isActive
                  ? "bg-slate-700 text-white border-l-4 border-blue-400"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
              }`}
              title={item.label}
            >
              <Icon size={20} className="shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}

        {/* Programs with sub-items */}
        <div>
          {collapsed ? (
            <Link
              href="/programs"
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                isProgramsActive
                  ? "bg-slate-700 text-white border-l-4 border-blue-400"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
              }`}
              title="Programs"
            >
              <ShieldCheck size={20} className="shrink-0" />
            </Link>
          ) : (
            <>
              <button
                onClick={() => setProgramsOpen((prev) => !prev)}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors ${
                  isProgramsActive
                    ? "bg-slate-700 text-white border-l-4 border-blue-400"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
                }`}
              >
                <ShieldCheck size={20} className="shrink-0" />
                <span className="flex-1 text-left">Programs</span>
                <ChevronDown
                  size={16}
                  className={`transition-transform ${programsOpen ? "rotate-0" : "-rotate-90"}`}
                />
              </button>
              {programsOpen && (
                <div className="ml-4 border-l border-slate-700">
                  <Link
                    href="/programs"
                    className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                      pathname === "/programs"
                        ? "text-white bg-slate-700"
                        : "text-slate-400 hover:text-white hover:bg-slate-800"
                    }`}
                  >
                    <ShieldCheck size={16} className="shrink-0" />
                    <span>Overview</span>
                  </Link>
                  {programSubItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                          isActive
                            ? "text-white bg-slate-700"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        <ShieldCheck size={16} className="shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Offerings with sub-items */}
        <div>
          {collapsed ? (
            <Link
              href="/offerings"
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                isOfferingsActive
                  ? "bg-slate-700 text-white border-l-4 border-blue-400"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
              }`}
              title="Offerings"
            >
              <Package size={20} className="shrink-0" />
            </Link>
          ) : (
            <>
              <button
                onClick={() => setOfferingsOpen((prev) => !prev)}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors ${
                  isOfferingsActive
                    ? "bg-slate-700 text-white border-l-4 border-blue-400"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
                }`}
              >
                <Package size={20} className="shrink-0" />
                <span className="flex-1 text-left">Offerings</span>
                <ChevronDown
                  size={16}
                  className={`transition-transform ${offeringsOpen ? "rotate-0" : "-rotate-90"}`}
                />
              </button>
              {offeringsOpen && (
                <div className="ml-4 border-l border-slate-700">
                  <Link
                    href="/offerings"
                    className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                      pathname === "/offerings"
                        ? "text-white bg-slate-700"
                        : "text-slate-400 hover:text-white hover:bg-slate-800"
                    }`}
                  >
                    <Package size={16} className="shrink-0" />
                    <span>Overview</span>
                  </Link>
                  {offeringSubItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                          isActive
                            ? "text-white bg-slate-700"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        <Package size={16} className="shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Reports with sub-items */}
        <div>
          {collapsed ? (
            <Link
              href="/reports"
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                isReportsActive
                  ? "bg-slate-700 text-white border-l-4 border-blue-400"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
              }`}
              title="Reports"
            >
              <FileBarChart size={20} className="shrink-0" />
            </Link>
          ) : (
            <>
              <button
                onClick={() => setReportsOpen((prev) => !prev)}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors ${
                  isReportsActive
                    ? "bg-slate-700 text-white border-l-4 border-blue-400"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
                }`}
              >
                <FileBarChart size={20} className="shrink-0" />
                <span className="flex-1 text-left">Reports</span>
                <ChevronDown
                  size={16}
                  className={`transition-transform ${reportsOpen ? "rotate-0" : "-rotate-90"}`}
                />
              </button>
              {reportsOpen && (
                <div className="ml-4 border-l border-slate-700">
                  <Link
                    href="/reports"
                    className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                      pathname === "/reports"
                        ? "text-white bg-slate-700"
                        : "text-slate-400 hover:text-white hover:bg-slate-800"
                    }`}
                  >
                    <FileBarChart size={16} className="shrink-0" />
                    <span>Overview</span>
                  </Link>
                  {reportSubItems.map((item) => {
                    const isActive = pathname === item.href;
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                          isActive
                            ? "text-white bg-slate-700"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        <Icon size={16} className="shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Admin with sub-items — only visible to Admin role */}
        {isAdmin && (
          <div>
            {collapsed ? (
              <Link
                href="/admin"
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  isAdminActive
                    ? "bg-slate-700 text-white border-l-4 border-blue-400"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
                }`}
                title="Admin"
              >
                <Settings size={20} className="shrink-0" />
              </Link>
            ) : (
              <>
                <button
                  onClick={() => setAdminOpen((prev) => !prev)}
                  className={`w-full flex items-center gap-3 px-4 py-3 transition-colors ${
                    isAdminActive
                      ? "bg-slate-700 text-white border-l-4 border-blue-400"
                      : "text-slate-300 hover:bg-slate-800 hover:text-white border-l-4 border-transparent"
                  }`}
                >
                  <Settings size={20} className="shrink-0" />
                  <span className="flex-1 text-left">Admin</span>
                  <ChevronDown
                    size={16}
                    className={`transition-transform ${adminOpen ? "rotate-0" : "-rotate-90"}`}
                  />
                </button>
                {adminOpen && (
                  <div className="ml-4 border-l border-slate-700">
                    <Link
                      href="/admin"
                      className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                        pathname === "/admin"
                          ? "text-white bg-slate-700"
                          : "text-slate-400 hover:text-white hover:bg-slate-800"
                      }`}
                    >
                      <Settings size={16} className="shrink-0" />
                      <span>Overview</span>
                    </Link>
                    {adminSubItems.filter((item) => !item.superAdminOnly || isSuperAdmin).map((item) => {
                      const isActive = pathname === item.href;
                      const Icon = item.icon;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                            isActive
                              ? "text-white bg-slate-700"
                              : "text-slate-400 hover:text-white hover:bg-slate-800"
                          }`}
                        >
                          <Icon size={16} className="shrink-0" />
                          <span>{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </nav>
      {/* User info + logout */}
      <div className="shrink-0 border-t border-slate-700 p-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Link
              href="/account"
              className="p-1 rounded hover:bg-slate-700 transition-colors"
              title="My Account"
            >
              <UserCog size={20} className="text-slate-400" />
            </Link>
            <button
              onClick={toggleTheme}
              className="p-1 rounded hover:bg-slate-700 transition-colors"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={20} className="text-slate-400" /> : <Moon size={20} className="text-slate-400" />}
            </button>
            <Link
              href="/about"
              className="p-1 rounded hover:bg-slate-700 transition-colors"
              title="About"
            >
              <Info size={20} className="text-slate-400" />
            </Link>
            <button
              onClick={logout}
              className="p-1 rounded hover:bg-slate-700 transition-colors"
              title="Sign out"
            >
              <LogOut size={20} className="text-slate-400" />
            </button>
          </div>
        ) : (
          <>
            {user && (
              <Link
                href="/account"
                className={`flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
                  pathname === "/account"
                    ? "bg-slate-700"
                    : "hover:bg-slate-700"
                }`}
                title="My Account"
              >
                <User size={16} className="text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">
                    {user.displayName}
                  </div>
                  <div className="text-xs text-slate-500">{user.role}</div>
                </div>
              </Link>
            )}
            <button
              onClick={toggleTheme}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              <span>{theme === "dark" ? "Light Mode" : "Night Mode"}</span>
            </button>
            <Link
              href="/about"
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded transition-colors ${
                pathname === "/about"
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-white hover:bg-slate-700"
              }`}
            >
              <Info size={16} />
              <span>About</span>
            </Link>
            <button
              onClick={logout}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            >
              <LogOut size={16} />
              <span>Sign out</span>
            </button>
            <div className="mt-2 text-center">
              <span className="text-xs text-slate-500">
                Version {process.env.APP_VERSION}
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
