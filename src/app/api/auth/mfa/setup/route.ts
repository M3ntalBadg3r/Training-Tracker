import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getAuthFromRequest,
  generateMfaSecret,
  generateMfaQrCode,
  sealMfaSecret,
  accountDisabledResponse,
} from "@/lib/auth";
import {
  isUserDisabled,
  isUserDeleted,
  isSessionEpochStale,
} from "@/lib/user-status";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getBrandingSafe } from "@/lib/system-settings";

// POST: Generate MFA secret + QR code for the current user
export async function POST(request: NextRequest) {
  const authUser = await getAuthFromRequest(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // These enrolment routes use `getAuthFromRequest` rather than `requireAuth`,
  // because they must stay reachable while the session is pending MFA
  // enrolment. That means the checks `requireAuth` performs are not inherited
  // and have to be explicit — without them a *suspended* (or deleted) account
  // could still rewrite its own MFA secret and complete enrolment, and on the
  // `mustEnableMfa` path be handed a fresh, unlocked session cookie.
  if (await isUserDisabled(authUser.sub)) return accountDisabledResponse();
  if (await isUserDeleted(authUser.sub)) return accountDisabledResponse();
  if (await isSessionEpochStale(authUser.sub, authUser.sessionEpoch)) {
    return accountDisabledResponse();
  }

  // This route overwrites the account's stored MFA secret on every call, so it
  // is limited like the verify side already is — otherwise it can be hammered to
  // churn a user's enrolment, and it is reachable during pending-MFA enrolment.
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`mfa-setup:${authUser.sub}:${ip}`, 5, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      }
    );
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.sub } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user.mfaEnabled) {
    return NextResponse.json(
      { error: "MFA is already enabled" },
      { status: 400 }
    );
  }

  // Brand the authenticator-app entry so a white-labelled install doesn't show
  // the stock product name in the user's authenticator.
  const { appName } = await getBrandingSafe();
  const { secret, uri } = generateMfaSecret(user.username, appName);
  const qrCode = await generateMfaQrCode(uri);

  // Store the secret temporarily (not enabled yet until verified). The
  // returned `secret` is the base32 string the authenticator app needs to
  // see; what we persist is the encrypted form.
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: sealMfaSecret(secret) },
  });

  return NextResponse.json({ qrCode, secret });
}
