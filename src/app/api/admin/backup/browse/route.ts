import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";
import { backupRoot, resolveWithin } from "@/lib/safe-path";

/**
 * Folder picker for the automatic-backup location.
 *
 * It is confined to `backupRoot()`. Unconfined, it listed any directory on the
 * server and — via `accessSync` and `existsSync` — reported whether each was
 * writable and whether it existed at all, which is more than a folder picker
 * needs and more than a backup destination could ever use: the route that saves
 * the choice has always refused anything outside the root.
 */

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const root = backupRoot();
  const requestedPath = request.nextUrl.searchParams.get("path");
  const resolvedPath = resolveWithin(root, requestedPath ?? root, { allowBase: true });

  if (!resolvedPath) {
    return NextResponse.json(
      { error: `Path must be inside ${root}.`, basePath: root },
      { status: 400 }
    );
  }

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

    // Stop the "up one level" walk at the root rather than at "/".
    const parentPath = resolvedPath === root ? null : path.dirname(resolvedPath);

    return NextResponse.json({
      basePath: root,
      currentPath: resolvedPath,
      parentPath,
      directories,
      writable,
    });
  } catch {
    return NextResponse.json({
      basePath: root,
      currentPath: resolvedPath,
      parentPath: resolvedPath === root ? null : path.dirname(resolvedPath),
      directories: [],
      writable: false,
      error: "Cannot read directory",
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
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

    const root = backupRoot();

    // The parent must be inside the root. The previous check compared the new
    // path against `path.resolve(dirPath)` — the caller's own input — so it
    // could never fail, and the parent was never constrained at all.
    const parent = resolveWithin(root, dirPath, { allowBase: true });
    if (!parent) {
      return NextResponse.json(
        { error: `Path must be inside ${root}.` },
        { status: 400 }
      );
    }

    // Sanitize folder name. The separator strip leaves "." and ".." intact, so
    // reject those explicitly rather than relying on the containment check.
    const safeName = String(name).replace(/[/\\:*?"<>|]/g, "").trim();
    if (!safeName || safeName === "." || safeName === "..") {
      return NextResponse.json(
        { error: "Invalid folder name" },
        { status: 400 }
      );
    }

    const newPath = resolveWithin(root, path.join(parent, safeName));
    if (!newPath) {
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
