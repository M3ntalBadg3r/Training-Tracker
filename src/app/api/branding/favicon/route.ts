import { NextRequest } from "next/server";
import { serveBrandingImage } from "@/lib/branding-image";

// Public: the browser requests the favicon on the login page, pre-auth.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return serveBrandingImage(request, "favicon");
}
