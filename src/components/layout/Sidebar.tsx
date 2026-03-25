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
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/students", label: "Students", icon: Users },
  { href: "/training", label: "Training", icon: GraduationCap },
  { href: "/reports", label: "Reports", icon: FileBarChart },
];

const adminSubItems = [
  { href: "/admin/import", label: "Import", icon: Upload },
  { href: "/admin/region-data", label: "Region Data", icon: Globe },
  { href: "/admin/training-data", label: "Training Data", icon: BookOpen },
  { href: "/admin/backup", label: "Backup", icon: HardDrive },
  { href: "/admin/users", label: "Users", icon: Users },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, isAdmin, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);

  const isAdminActive = pathname.startsWith("/admin");

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setCollapsed(stored === "true");
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
        )}
      </nav>
      {/* User info + logout */}
      <div className="border-t border-slate-700 p-3">
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
              <div className="flex items-center gap-2 mb-2">
                <User size={16} className="text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">
                    {user.displayName}
                  </div>
                  <div className="text-xs text-slate-500">{user.role}</div>
                </div>
              </div>
            )}
            <Link
              href="/account"
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded transition-colors ${
                pathname === "/account"
                  ? "text-white bg-slate-700"
                  : "text-slate-400 hover:text-white hover:bg-slate-700"
              }`}
            >
              <UserCog size={16} />
              <span>My Account</span>
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
