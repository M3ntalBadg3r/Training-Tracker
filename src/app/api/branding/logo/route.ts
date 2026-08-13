import { NextRequest } from "next/server";
import { serveBrandingImage } from "@/lib/branding-image";

// Public: the login and first-run setup pages render the logo before anyone
// has authenticated. proxy.ts allows /api/branding/* for the same reason.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return serveBrandingImage(request, "logo");
}
