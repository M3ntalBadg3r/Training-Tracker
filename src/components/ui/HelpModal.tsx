"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export default function HelpModal({
  open,
  onClose,
  title,
  children,
}: HelpModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="fixed z-50 rounded-lg p-0 shadow-xl backdrop:bg-black/50 m-auto inset-0"
    >
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-6 pb-3 border-b border-gray-200">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6 pt-4 overflow-y-auto help-content">{children}</div>
      </div>
      <style>{`
        .help-content h3 {
          font-size: 1rem;
          font-weight: 600;
          margin-top: 1rem;
          margin-bottom: 0.5rem;
          color: #111827;
        }
        .help-content h4 {
          font-size: 0.875rem;
          font-weight: 600;
          margin-top: 0.75rem;
          margin-bottom: 0.25rem;
          color: #374151;
        }
        .help-content p {
          font-size: 0.875rem;
          color: #4b5563;
          margin-bottom: 0.5rem;
          line-height: 1.5;
        }
        .help-content ul,
        .help-content ol {
          font-size: 0.875rem;
          color: #4b5563;
          margin-bottom: 0.5rem;
          padding-left: 1.25rem;
        }
        .help-content ul {
          list-style-type: disc;
        }
        .help-content ol {
          list-style-type: decimal;
        }
        .help-content li {
          margin-bottom: 0.25rem;
          line-height: 1.5;
        }
        .help-content table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.875rem;
          margin-bottom: 0.75rem;
        }
        .help-content th {
          text-align: left;
          padding: 0.5rem;
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          font-weight: 600;
          color: #374151;
        }
        .help-content td {
          padding: 0.5rem;
          border: 1px solid #e5e7eb;
          color: #4b5563;
        }
        .help-content code {
          font-size: 0.8125rem;
          background: #f3f4f6;
          padding: 0.125rem 0.375rem;
          border-radius: 0.25rem;
          color: #1f2937;
        }
        .help-content strong {
          color: #1f2937;
        }
      `}</style>
    </dialog>
  );
}
