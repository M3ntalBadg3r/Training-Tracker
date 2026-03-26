import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";

const VALID_PROVIDERS = ["email", "google-drive", "box", "onedrive"];

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const credentials = await prisma.exportCredential.findMany();
  // Return which providers are configured (without exposing secrets)
  const configured = credentials.map((c) => ({ provider: c.provider, updatedAt: c.updatedAt }));
  return NextResponse.json(configured);
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const body = await request.json();
    const { provider, config } = body;

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!config || typeof config !== "object") {
      return NextResponse.json({ error: "Missing config" }, { status: 400 });
    }

    const record = await prisma.exportCredential.upsert({
      where: { provider },
      create: { provider, config },
      update: { config },
    });

    return NextResponse.json({ success: true, provider: record.provider, updatedAt: record.updatedAt });
  } catch {
    return NextResponse.json({ error: "Failed to save credentials" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    await prisma.exportCredential.delete({ where: { provider } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete credentials" }, { status: 500 });
  }
}
