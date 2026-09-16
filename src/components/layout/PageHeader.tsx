"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleHelp } from "lucide-react";
import HelpModal from "@/components/ui/HelpModal";
import { getHelpContent } from "@/lib/help-content";

interface PageHeaderProps {
  title: string;
  /** One line under the title saying what the page is for. */
  description?: string;
  /**
   * Named destination for the back link, e.g. `/reports`. Preferred over
   * `showBack`: the 12 report pages already hand-rolled exactly this link
   * because a bare arrow calling `router.back()` cannot say where it goes and
   * can walk the user out of the app entirely.
   */
  backHref?: string;
  backLabel?: string;
  /** Legacy bare-arrow `router.back()`. Prefer `backHref`/`backLabel`. */
  showBack?: boolean;
  rightContent?: React.ReactNode;
  helpSlug?: string;
}

export default function PageHeader({
  title,
  description,
  backHref,
  backLabel,
  showBack,
  rightContent,
  helpSlug,
}: PageHeaderProps) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const help = helpSlug ? getHelpContent(helpSlug) : null;

  return (
    <div className="mb-6">
      {backHref && (
        <div className="flex items-center gap-2 mb-2">
          <Link
            href={backHref}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft size={14} /> {backLabel ?? "Back"}
          </Link>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          {showBack && (
            <button
              onClick={() => router.back()}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="Go back"
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
            {description && (
              <p className="text-sm text-gray-500 mt-0.5">{description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {rightContent && <div>{rightContent}</div>}
          {help && (
            <>
              <button
                onClick={() => setHelpOpen(true)}
                className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
                title="Help"
              >
                <CircleHelp size={20} />
              </button>
              <HelpModal
                open={helpOpen}
                onClose={() => setHelpOpen(false)}
                title={help.title}
              >
                {help.content}
              </HelpModal>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
