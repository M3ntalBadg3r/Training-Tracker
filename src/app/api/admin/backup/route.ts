import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import JSZip from "jszip";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import {
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  isEncryptionConfigured,
} from "@/lib/crypto";
import { prepareBackupRestore } from "@/lib/product-types";

/**
 * Wraps generateBackupZip with envelope encryption (AES-256-GCM, keyed by
 * ENCRYPTION_KEY) when configured. Returns the bytes ready to write to disk
 * or stream to the client, plus the filename that should be used (the
 * ".zip.enc" suffix is the on-disk discriminator; isEncryptedBuffer() is the
 * authoritative check during restore).
 */
export async function generateBackupArchive(): Promise<{
  buffer: Buffer;
  timestamp: string;
  filename: string;
  encrypted: boolean;
  contentType: string;
}> {
  const { buffer, timestamp } = await generateBackupZip();
  const zipBuf = Buffer.from(buffer);
  if (isEncryptionConfigured()) {
    const enc = encryptBuffer(zipBuf);
    return {
      buffer: enc,
      timestamp,
      filename: `training-tracker-backup-${timestamp}.zip.enc`,
      encrypted: true,
      contentType: "application/octet-stream",
    };
  }
  return {
    buffer: zipBuf,
    timestamp,
    filename: `training-tracker-backup-${timestamp}.zip`,
    encrypted: false,
    contentType: "application/zip",
  };
}

/**
 * Decrypt-if-needed loader for a backup archive. Accepts either:
 *  - a raw ZIP buffer (legacy / unencrypted deployments), or
 *  - an envelope-encrypted buffer (magic 'TT01' + IV + tag + ciphertext)
 * and returns the inner ZIP bytes ready for JSZip.loadAsync.
 */
export async function loadBackupArchive(input: ArrayBuffer | Buffer): Promise<Buffer> {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (isEncryptedBuffer(buf)) {
    if (!isEncryptionConfigured()) {
      throw new Error(
        "Archive is encrypted but ENCRYPTION_KEY is not configured. Set ENCRYPTION_KEY to the same value used when the backup was created."
      );
    }
    return decryptBuffer(buf);
  }
  return buf;
}

export async function generateBackupZip(): Promise<{
  buffer: ArrayBuffer;
  timestamp: string;
}> {
  const [productTypes, regionData, trainingData, students, trainingTaken, importMetadata, users] =
    await Promise.all([
      prisma.productType.findMany({ orderBy: { id: "asc" } }),
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
  zip.file("product_types.json", JSON.stringify(productTypes, null, 2));
  zip.file("region_data.json", JSON.stringify(regionData, null, 2));
  zip.file("training_data.json", JSON.stringify(trainingData, null, 2));
  zip.file("students.json", JSON.stringify(students, null, 2));
  zip.file("training_taken.json", JSON.stringify(trainingTaken, null, 2));
  zip.file("import_metadata.json", JSON.stringify(importMetadata, null, 2));
  // Exclude sensitive fields (password hashes, MFA secrets) from backup
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const safeUsers = users.map(({ passwordHash: _ph, mfaSecret: _ms, ...rest }: typeof users[number]) => rest);
  zip.file("users.json", JSON.stringify(safeUsers, null, 2));

  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  return { buffer, timestamp };
}

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { buffer, filename, contentType } = await generateBackupArchive();

  return new NextResponse(new Blob([new Uint8Array(buffer)]), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  let zipBytes: Buffer;
  try {
    zipBytes = await loadBackupArchive(arrayBuffer);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read archive" },
      { status: 400 }
    );
  }
  const zip = await JSZip.loadAsync(zipBytes);

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

  const productTypesFile = zip.file("product_types.json");
  const productTypesJson = productTypesFile ? await readJson("product_types.json") : null;
  const regionData = await readJson("region_data.json");
  const trainingDataJson = await readJson("training_data.json");
  const students = await readJson("students.json");
  const trainingTaken = await readJson("training_taken.json");

  // Reconcile product types (new archive) or synthesise them from the old
  // enum-string shape so pre-migration backups still restore.
  const { productTypeRows, trainingDataRows: trainingData } = prepareBackupRestore(
    productTypesJson,
    trainingDataJson
  );

  const importMetadataFile = zip.file("import_metadata.json");
  const importMetadata = importMetadataFile
    ? await readJson("import_metadata.json")
    : [];

  const usersFile = zip.file("users.json");
  const users = usersFile ? await readJson("users.json") : [];

  // Restore inside a transaction: wipe then re-insert in FK order
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.productType.deleteMany({});
    await tx.regionData.deleteMany({});
    await tx.importMetadata.deleteMany({});
    await tx.user.deleteMany({});

    if (productTypeRows.length > 0) {
      await tx.productType.createMany({ data: productTypeRows });
    }
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
    // Only restore users that have passwordHash (security-sanitized backups omit it)
    const usersWithCredentials = users.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (u: any) => u.passwordHash
    );
    if (usersWithCredentials.length > 0) {
      const userRows = usersWithCredentials.map(
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
