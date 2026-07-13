import { NextRequest, NextResponse } from "next/server";
import { getAuthFromRequest } from "@/lib/auth";

// Keep-alive endpoint for the client idle-timeout manager. It does no work of
// its own — simply reaching an authenticated route lets proxy.ts slide the
// session token's idle window forward, so an active-but-not-navigating user
// doesn't have their session expire under them.
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
