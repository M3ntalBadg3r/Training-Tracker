import { NextRequest, NextResponse } from "next/server";
import { getAuthFromRequest, accountDisabledResponse } from "@/lib/auth";
import { isUserDisabled } from "@/lib/user-status";

// Keep-alive endpoint for the client idle-timeout manager. It does no work of
// its own — simply reaching an authenticated route lets proxy.ts slide the
// session token's idle window forward, so an active-but-not-navigating user
// doesn't have their session expire under them.
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // This route uses `getAuthFromRequest` rather than `requireAuth`, so the
  // suspension check has to be explicit. It is what signs out a tab that is
  // sitting idle: the keep-alive ping is the only request such a tab makes.
  if (await isUserDisabled(authUser.sub)) return accountDisabledResponse();
  return NextResponse.json({ ok: true });
}
