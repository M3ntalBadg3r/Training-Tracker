import { NextRequest, NextResponse } from "next/server";
import { clearAuthCookie, isRequestSecure } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  clearAuthCookie(response, isRequestSecure(request));
  return response;
}
