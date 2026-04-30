"use client";

import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import {
  Globe,
  BookOpen,
  HardDrive,
  Upload,
  ChevronRight,
  Users,
  Building2,
  Sparkles,
  RefreshCw,
  CalendarClock,
  ClipboardList,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

interface AdminCard {
  href: string;
  title: string;
  description: string;
  icon: typeof Users;
  superAdminOnly?: boolean;
}

// Cards mirror the sidebar's Admin submenu and the proxy's allow-list:
// SuperAdmin sees all; Admin sees only the cards they can actually use.
const ADMIN_CARDS: AdminCard[] = [
  { href: "/admin/users", title: "User Management", description: "Manage user accounts, roles, and MFA", icon: Users, superAdminOnly: true },
  { href: "/admin/companies", title: "Companies", description: "Add, rename, and delete companies", icon: Building2, superAdminOnly: true },
  { href: "/admin/program-data", title: "Program Data", description: "Manage partner program compliance requirements", icon: ClipboardList, superAdminOnly: true },
  { href: "/admin/training-data", title: "Training Data", description: "Manage training programs", icon: BookOpen, superAdminOnly: true },
  { href: "/admin/region-data", title: "Region Data", description: "Manage countries and regions", icon: Globe, superAdminOnly: true },
  { href: "/admin/cleanup", title: "Data Clean-Up", description: "Scan and fix data quality issues", icon: Sparkles, superAdminOnly: true },
  { href: "/admin/backup", title: "Backup & Restore", description: "Export or import system data", icon: HardDrive, superAdminOnly: true },
  { href: "/admin/import", title: "Import", description: "Import student training data from CSV or Excel", icon: Upload },
  { href: "/admin/scheduled-exports", title: "Scheduled Exports", description: "Automate report delivery on a schedule", icon: CalendarClock },
  { href: "/admin/updates", title: "Updates", description: "Check for and apply application updates", icon: RefreshCw, superAdminOnly: true },
];

export default function AdminPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SuperAdmin";
  const visibleCards = ADMIN_CARDS.filter((c) => !c.superAdminOnly || isSuperAdmin);

  return (
    <div>
      <PageHeader title="Admin" helpSlug="admin" />

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleCards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.href}
              href={card.href}
              className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3">
                <Icon size={20} className="text-blue-600" />
                <div>
                  <h3 className="font-semibold">{card.title}</h3>
                  <p className="text-sm text-gray-500">{card.description}</p>
                </div>
              </div>
              <ChevronRight size={20} className="text-gray-400" />
            </Link>
          );
        })}
      </section>
    </div>
  );
}
