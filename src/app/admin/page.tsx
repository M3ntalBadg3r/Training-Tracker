"use client";

import { useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { AlertTriangle, Globe, BookOpen, ChevronRight } from "lucide-react";

export default function AdminPage() {
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeText, setWipeText] = useState("");
  const [wiping, setWiping] = useState(false);

  const handleWipe = async () => {
    if (wipeText !== "WIPE") return;
    setWiping(true);
    try {
      await fetch("/api/admin/wipe", { method: "POST" });
      setShowWipeConfirm(false);
      setWipeText("");
    } finally {
      setWiping(false);
    }
  };

  return (
    <div>
      <PageHeader title="Admin" />

      {/* Sub-page links */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2">
        <Link
          href="/admin/region-data"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <Globe size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Region Data</h3>
              <p className="text-sm text-gray-500">Manage countries and regions</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
        <Link
          href="/admin/training-data"
          className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-center gap-3">
            <BookOpen size={20} className="text-blue-600" />
            <div>
              <h3 className="font-semibold">Training Data</h3>
              <p className="text-sm text-gray-500">Manage training programs</p>
            </div>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </Link>
      </section>

      {/* Wipe Data Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Danger Zone</h2>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={24} className="text-red-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-red-800">Wipe All Data</h3>
              <p className="text-sm text-red-600 mt-1">
                This will permanently delete all students, training records,
                training data, and region data. This action cannot be undone.
              </p>
              <button
                onClick={() => setShowWipeConfirm(true)}
                className="mt-3 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Wipe All Data
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Wipe Confirmation Modal */}
      <Modal
        open={showWipeConfirm}
        onClose={() => {
          setShowWipeConfirm(false);
          setWipeText("");
        }}
        title="Confirm Data Wipe"
        actions={
          <>
            <button
              onClick={() => {
                setShowWipeConfirm(false);
                setWipeText("");
              }}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleWipe}
              disabled={wipeText !== "WIPE" || wiping}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {wiping ? "Wiping..." : "Confirm Wipe"}
            </button>
          </>
        }
      >
        <p className="text-gray-600 mb-3">
          This will permanently delete ALL data. Type{" "}
          <strong>WIPE</strong> to confirm.
        </p>
        <input
          type="text"
          value={wipeText}
          onChange={(e) => setWipeText(e.target.value)}
          placeholder="Type WIPE to confirm"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </Modal>

      {/* Version */}
      <div className="text-sm text-gray-400 text-right">
        Version 1.00
      </div>
    </div>
  );
}
