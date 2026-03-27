import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import nodemailer from "nodemailer";

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const body = await request.json();
    const { provider } = body;

    if (provider !== "email") {
      return NextResponse.json(
        { success: false, error: "Only email (SMTP) connections can be tested" },
        { status: 400 }
      );
    }

    const cred = await prisma.exportCredential.findUnique({
      where: { provider: "email" },
    });

    if (!cred) {
      return NextResponse.json(
        { success: false, error: "Email credentials not configured. Save credentials first." },
        { status: 400 }
      );
    }

    const config = cred.config as Record<string, unknown>;

    const transporter = nodemailer.createTransport({
      host: String(config.host ?? ""),
      port: Number(config.port ?? 587),
      secure: Boolean(config.secure),
      auth: {
        user: String(config.user ?? ""),
        pass: String(config.password ?? ""),
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.verify();

    return NextResponse.json({ success: true });
  } catch (err) {
    let message = err instanceof Error ? err.message : "Connection test failed";
    if (message.includes("wrong version number")) {
      message +=
        " — SSL/TLS version mismatch. If using port 587, uncheck 'Implicit SSL/TLS (port 465)'. If using port 465, check it.";
    }
    return NextResponse.json({ success: false, error: message });
  }
}
