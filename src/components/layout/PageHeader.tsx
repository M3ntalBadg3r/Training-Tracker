"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

interface PageHeaderProps {
  title: string;
  showBack?: boolean;
}

export default function PageHeader({ title, showBack }: PageHeaderProps) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-4 mb-6">
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
  );
}
