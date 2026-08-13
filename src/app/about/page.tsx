"use client";

import PageHeader from "@/components/layout/PageHeader";
import { ExternalLink, FileText } from "lucide-react";
import { useBrand } from "@/components/brand/BrandProvider";

const REPO_URL = "https://github.com/M3ntalBadg3r/Training-Tracker";
const RELEASES_URL = `${REPO_URL}/releases`;

export default function AboutPage() {
  const { appName } = useBrand();
  return (
    <div>
      <PageHeader title={`About ${appName}`} />
      <div className="max-w-2xl space-y-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
          <p className="text-gray-600 leading-relaxed">
            A full-stack application for tracking student certifications,
            accreditations, and instructor-led training programs across product
            lines and business functions.
          </p>

          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-gray-900">
              Current Version
            </h2>
            <p className="text-gray-600">
              Version {process.env.APP_VERSION}
            </p>
          </div>

          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-gray-900">Developed by</h2>
            <p className="text-gray-600">Karl Seaton</p>
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-900">Links</h2>
            <div className="flex flex-col gap-2">
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 hover:underline"
              >
                <FileText size={16} />
                <span>Release notes</span>
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 hover:underline"
              >
                <ExternalLink size={16} />
                <span>GitHub repository</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
