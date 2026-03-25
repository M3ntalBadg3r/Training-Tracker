import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const requestedPath = request.nextUrl.searchParams.get("path") || "/opt/training-tracker/backups";
  const resolvedPath = path.resolve(requestedPath);

  try {
    let directories: { name: string; path: string }[] = [];
    let writable = false;

    if (fs.existsSync(resolvedPath)) {
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      directories = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({
          name: e.name,
          path: path.join(resolvedPath, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      try {
        fs.accessSync(resolvedPath, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }

    const parentPath = resolvedPath === "/" ? null : path.dirname(resolvedPath);

    return NextResponse.json({
      currentPath: resolvedPath,
      parentPath,
      directories,
      writable,
    });
  } catch {
    return NextResponse.json({
      currentPath: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      directories: [],
      writable: false,
      error: "Cannot read directory",
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { path: dirPath, name } = await request.json();
    if (!dirPath || !name) {
      return NextResponse.json(
        { error: "Path and name are required" },
        { status: 400 }
      );
    }

    // Sanitize folder name
    const safeName = name.replace(/[/\\:*?"<>|]/g, "").trim();
    if (!safeName) {
      return NextResponse.json(
        { error: "Invalid folder name" },
        { status: 400 }
      );
    }

    const newPath = path.resolve(dirPath, safeName);

    if (!newPath.startsWith(path.resolve(dirPath))) {
      return NextResponse.json(
        { error: "Invalid path" },
        { status: 400 }
      );
    }

    fs.mkdirSync(newPath, { recursive: true });

    return NextResponse.json({ success: true, path: newPath });
  } catch {
    return NextResponse.json(
      { error: "Failed to create folder" },
      { status: 500 }
    );
  }
}
