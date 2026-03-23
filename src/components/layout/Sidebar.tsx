"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
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
} from "lucide-react";

const navItems = [
  { href: "/students", label: "Students", icon: Users },
  { href: "/training", label: "Training", icon: GraduationCap },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/reports", label: "Reports", icon: FileBarChart },
];

const adminSubItems = [
  { href: "/admin/region-data", label: "Region Data", icon: Globe },
  { href: "/admin/training-data", label: "Training Data", icon: BookOpen },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  const isAdminActive = pathname.startsWith("/admin");

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") setCollapsed(true);
  }, []);

  // Auto-expand admin submenu when on an admin page
  useEffect(() => {
    if (isAdminActive) setAdminOpen(true);
  }, [isAdminActive]);

  const toggle = () => {
    setCollapsed((prev) => {
      localStorage.setItem("sidebar-collapsed", String(!prev));
      return !prev;
    });
  };

  return (
    <aside
      className={`flex flex-col bg-slate-900 text-white transition-all duration-300 ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      <div className="flex items-center justify-between p-4 border-b border-slate-700">
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
      <nav className="flex-1 py-4">
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

        {/* Admin with sub-items */}
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
                    <span>General</span>
                  </Link>
                  {adminSubItems.map((item) => {
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
      </nav>
    </aside>
  );
}
