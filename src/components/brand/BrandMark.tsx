"use client";

import Image from "next/image";
import { ShieldCheck } from "lucide-react";
import { useBrand } from "./BrandProvider";

/**
 * The product mark shown on the pre-auth pages: the uploaded logo when one is
 * configured, otherwise the built-in shield. Kept in one place so the fallback
 * can't drift between the login, setup and MFA-enrolment screens.
 */
export default function BrandMark({ size = 32 }: { size?: number }) {
  const { logoUrl, appName } = useBrand();

  if (!logoUrl) {
    return <ShieldCheck size={size} className="text-blue-600 shrink-0" />;
  }

  // `unoptimized` because the source is an API route serving user-uploaded
  // bytes, not a build-time asset (same reasoning as the MFA QR codes).
  return (
    <Image
      src={logoUrl}
      alt={appName}
      width={size}
      height={size}
      unoptimized
      className="w-auto shrink-0 object-contain"
      style={{ height: size }}
    />
  );
}
