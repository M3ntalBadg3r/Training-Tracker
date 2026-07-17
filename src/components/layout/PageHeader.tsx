"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleHelp } from "lucide-react";
import HelpModal from "@/components/ui/HelpModal";
import { getHelpContent } from "@/lib/help-content";

interface PageHeaderProps {
  title: string;
  showBack?: boolean;
  rightContent?: React.ReactNode;
  helpSlug?: string;
}

export default function PageHeader({ title, showBack, rightContent, helpSlug }: PageHeaderProps) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const help = helpSlug ? getHelpContent(helpSlug) : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
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
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
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
  );
}
