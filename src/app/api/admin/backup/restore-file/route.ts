import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import JSZip from "jszip";
import { requireAuth, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";

const CONFIG_FILENAME = ".auto-backup.json";

function getBackupPath(): string {
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.backupPath || "/opt/training-tracker/backups";
  }
  return "/opt/training-tracker/backups";
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { filename } = await request.json();
    if (!filename) {
      return NextResponse.json({ error: "Filename is required" }, { status: 400 });
    }

    // Prevent path traversal
    const safeName = path.basename(filename);
    if (safeName !== filename || !safeName.endsWith(".zip")) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const backupPath = getBackupPath();
    const filePath = path.join(backupPath, safeName);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(fileBuffer);

    // Validate required files
    const requiredFiles = [
      "backup_metadata.json",
      "region_data.json",
      "training_data.json",
      "students.json",
      "training_taken.json",
    ];
    for (const name of requiredFiles) {
      if (!zip.file(name)) {
        return NextResponse.json(
          { error: `Invalid backup: missing ${name}` },
          { status: 400 }
        );
      }
    }

    const readJson = async (name: string) => {
      const content = await zip.file(name)!.async("string");
      return JSON.parse(content);
    };

    const regionData = await readJson("region_data.json");
    const trainingData = await readJson("training_data.json");
    const students = await readJson("students.json");
    const trainingTaken = await readJson("training_taken.json");

    const importMetadataFile = zip.file("import_metadata.json");
    const importMetadata = importMetadataFile
      ? await readJson("import_metadata.json")
      : [];

    const usersFile = zip.file("users.json");
    const users = usersFile ? await readJson("users.json") : [];

    await prisma.$transaction(async (tx) => {
      await tx.trainingTaken.deleteMany({});
      await tx.student.deleteMany({});
      await tx.trainingData.deleteMany({});
      await tx.regionData.deleteMany({});
      await tx.importMetadata.deleteMany({});
      await tx.user.deleteMany({});

      if (regionData.length > 0) {
        await tx.regionData.createMany({ data: regionData });
      }
      if (trainingData.length > 0) {
        await tx.trainingData.createMany({ data: trainingData });
      }
      if (students.length > 0) {
        await tx.student.createMany({ data: students });
      }
      if (trainingTaken.length > 0) {
        const rows = trainingTaken.map(
          ({
            id: _id,
            ...rest
          }: {
            id: number;
            email: string;
            trainingTitle: string;
            completedDate: string;
            expiryDate: string;
          }) => ({
            ...rest,
            completedDate: new Date(rest.completedDate),
            expiryDate: new Date(rest.expiryDate),
          })
        );
        await tx.trainingTaken.createMany({ data: rows });
      }
      if (importMetadata.length > 0) {
        const rows = importMetadata.map(
          (row: { key: string; timestamp: string }) => ({
            ...row,
            timestamp: new Date(row.timestamp),
          })
        );
        await tx.importMetadata.createMany({ data: rows });
      }
      if (users.length > 0) {
        const userRows = users.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ id: _id, ...rest }: any) => ({
            ...rest,
            createdAt: new Date(rest.createdAt),
            updatedAt: new Date(rest.updatedAt),
          })
        );
        await tx.user.createMany({ data: userRows });
      }
    });

    return NextResponse.json({
      success: true,
      counts: {
        regionData: regionData.length,
        trainingData: trainingData.length,
        students: students.length,
        trainingTaken: trainingTaken.length,
        importMetadata: importMetadata.length,
        users: users.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed" },
      { status: 500 }
    );
  }
}
