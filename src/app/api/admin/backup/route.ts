import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import JSZip from "jszip";
import { requireAuth, handleAuthError } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const [regionData, trainingData, students, trainingTaken, importMetadata, users] =
    await Promise.all([
      prisma.regionData.findMany({ orderBy: { country: "asc" } }),
      prisma.trainingData.findMany({ orderBy: { trainingTitle: "asc" } }),
      prisma.student.findMany({ orderBy: { email: "asc" } }),
      prisma.trainingTaken.findMany({ orderBy: { id: "asc" } }),
      prisma.importMetadata.findMany(),
      prisma.user.findMany({ orderBy: { id: "asc" } }),
    ]);

  const zip = new JSZip();
  zip.file(
    "backup_metadata.json",
    JSON.stringify(
      { version: process.env.APP_VERSION || "0.0.0", createdAt: new Date().toISOString() },
      null,
      2
    )
  );
  zip.file("region_data.json", JSON.stringify(regionData, null, 2));
  zip.file("training_data.json", JSON.stringify(trainingData, null, 2));
  zip.file("students.json", JSON.stringify(students, null, 2));
  zip.file("training_taken.json", JSON.stringify(trainingTaken, null, 2));
  zip.file("import_metadata.json", JSON.stringify(importMetadata, null, 2));
  zip.file("users.json", JSON.stringify(users, null, 2));

  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  return new NextResponse(new Blob([buffer]), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="training-tracker-backup-${timestamp}.zip"`,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Validate required files exist
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

  // Restore inside a transaction: wipe then re-insert in FK order
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
      // Strip auto-increment ids so the DB assigns new ones
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
}
