import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

// PUT: Update user (display name, role, mfa)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json();
  const { displayName, role } = body;

  if (role && !["Admin", "User"].includes(role)) {
    return NextResponse.json(
      { error: "Role must be Admin or User" },
      { status: 400 }
    );
  }

  // Prevent demoting the last admin
  if (role === "User") {
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (currentUser?.role === "Admin") {
      const adminCount = await prisma.user.count({
        where: { role: "Admin" },
      });
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: "Cannot demote the last admin" },
          { status: 400 }
        );
      }
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(displayName && { displayName }),
      ...(role && { role }),
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      mfaEnabled: true,
      createdAt: true,
    },
  });

  return NextResponse.json(user);
}

// DELETE: Delete a user
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let authUser;
  try {
    authUser = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { id } = await params;
  const userId = parseInt(id, 10);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  // Cannot delete yourself
  if (userId === authUser.sub) {
    return NextResponse.json(
      { error: "Cannot delete your own account" },
      { status: 400 }
    );
  }

  // Cannot delete the last admin
  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (targetUser?.role === "Admin") {
    const adminCount = await prisma.user.count({ where: { role: "Admin" } });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last admin" },
        { status: 400 }
      );
    }
  }

  await prisma.user.delete({ where: { id: userId } });
  return NextResponse.json({ success: true });
}
