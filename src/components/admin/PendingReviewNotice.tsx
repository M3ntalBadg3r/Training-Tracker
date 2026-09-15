"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

/**
 * Tells a SuperAdmin that some auto-created training entries are still
 * unclassified and are therefore being left out of the figures.
 *
 * A student import creates a catalogue entry for any training title it doesn't
 * recognise, with placeholder Type/Product/Function that nobody chose. Those
 * entries are excluded from every report and metric until an admin classifies
 * them (see `lib/reportable-training.ts`), which is the honest treatment — but
 * silently omitting real completions would be its own trap, so the omission is
 * stated wherever the numbers are read.
 *
 * SuperAdmin-only because `/admin/training-data` is, so they are the only ones
 * who can act on it. Deliberately not dismissible: unlike an available update,
 * this reports an ongoing inaccuracy in the numbers on the same screen.
 */
export default function PendingReviewNotice({ count }: { count: number }) {
  const { user } = useAuth();

  if (user?.role !== "SuperAdmin") return null;
  if (count <= 0) return null;

  return (
    <div className="mb-6 border rounded-lg px-4 py-3 bg-amber-50 border-amber-300 text-amber-900">
      <div className="flex items-start gap-3">
        <AlertCircle size={20} className="shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">
            {count} training {count === 1 ? "entry needs" : "entries need"} review
          </p>
          <p className="text-amber-800">
            {count === 1 ? "It was" : "They were"} created automatically by an import, so{" "}
            {count === 1 ? "its" : "their"} Type, Product and Function have not been set.{" "}
            {count === 1 ? "It is" : "They are"} left out of the figures below and every report
            until classified.{" "}
            <Link href="/admin/training-data" className="font-medium underline">
              Review in Training Data
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
