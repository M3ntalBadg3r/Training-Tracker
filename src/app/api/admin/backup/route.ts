import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import JSZip from "jszip";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import {
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  isEncryptionConfigured,
  isPassphraseEncryptedBuffer,
  decryptBufferWithPassphrase,
} from "@/lib/crypto";
import { prepareBackupRestore } from "@/lib/product-types";

// Backup archive variants. A "full" backup is the historical shape (everything,
// including students and training records). A "config" backup is the reference
// dataset only — the catalogue, programs, regions, etc. — for seeding a fresh
// system without copying learner data. The discriminator is `kind` inside
// `backup_metadata.json`; older archives without the field are treated as full.
export type BackupKind = "full" | "config";

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
 * Decrypt-if-needed loader for a backup archive. Accepts:
 *  - a raw ZIP buffer (legacy / unencrypted deployments),
 *  - a key-encrypted buffer (magic 'TT01' + IV + tag + ciphertext), keyed by
 *    this install's ENCRYPTION_KEY, or
 *  - a portable, passphrase-encrypted buffer (magic 'TT02' + salt + IV + tag +
 *    ciphertext) — restorable on any system given the original passphrase.
 * Returns the inner ZIP bytes ready for JSZip.loadAsync.
 */
export async function loadBackupArchive(
  input: ArrayBuffer | Buffer,
  passphrase?: string
): Promise<Buffer> {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (isPassphraseEncryptedBuffer(buf)) {
    if (!passphrase) {
      throw new Error(
        "This is a portable backup. Enter the passphrase it was created with to restore it."
      );
    }
    return decryptBufferWithPassphrase(buf, passphrase);
  }
  if (isEncryptedBuffer(buf)) {
    if (!isEncryptionConfigured()) {
      throw new Error(
        "Archive is encrypted but ENCRYPTION_KEY is not configured. Set ENCRYPTION_KEY to the same value used when the backup was created, or restore a portable backup instead."
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
  const [productTypes, regionData, trainingData, students, trainingTaken, importMetadata, users, importAliases] =
    await Promise.all([
      prisma.productType.findMany({ orderBy: { id: "asc" } }),
      prisma.regionData.findMany({ orderBy: { country: "asc" } }),
      prisma.trainingData.findMany({ orderBy: { trainingTitle: "asc" } }),
      prisma.student.findMany({ orderBy: { email: "asc" } }),
      prisma.trainingTaken.findMany({ orderBy: { id: "asc" } }),
      prisma.importMetadata.findMany(),
      prisma.user.findMany({ orderBy: { id: "asc" } }),
      prisma.importAlias.findMany({ orderBy: { id: "asc" } }),
    ]);

  const zip = new JSZip();
  zip.file(
    "backup_metadata.json",
    JSON.stringify(
      {
        version: process.env.APP_VERSION || "0.0.0",
        kind: "full" satisfies BackupKind,
        createdAt: new Date().toISOString(),
      },
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
  zip.file("import_aliases.json", JSON.stringify(importAliases, null, 2));
  // Exclude sensitive fields (password hashes, MFA secrets) from backup
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const safeUsers = users.map(({ passwordHash: _ph, mfaSecret: _ms, ...rest }: typeof users[number]) => rest);
  zip.file("users.json", JSON.stringify(safeUsers, null, 2));

  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  return { buffer, timestamp };
}

/**
 * Builds a config-only backup ZIP: catalogue, regions, programs, specialisations,
 * import aliases, system settings. Excludes Student/TrainingTaken (and Users,
 * Companies, ExportCredential, ScheduledExport, ImportMetadata) so it can seed
 * a fresh system without dragging over learner data.
 */
export async function generateConfigZip(): Promise<{
  buffer: ArrayBuffer;
  timestamp: string;
}> {
  const [
    productTypes,
    regionData,
    trainingData,
    olxSubItemRelations,
    programs,
    programTiers,
    specialisations,
    programData,
    programDataAlternatives,
    importAliases,
    systemSetting,
  ] = await Promise.all([
    prisma.productType.findMany({ orderBy: { id: "asc" } }),
    prisma.regionData.findMany({ orderBy: { country: "asc" } }),
    prisma.trainingData.findMany({ orderBy: { trainingTitle: "asc" } }),
    prisma.olxSubItemRelation.findMany({ orderBy: [{ parentTrainingTitle: "asc" }, { subItemTrainingTitle: "asc" }] }),
    prisma.program.findMany({ orderBy: { id: "asc" } }),
    prisma.programTier.findMany({ orderBy: { id: "asc" } }),
    prisma.specialisation.findMany({ orderBy: { id: "asc" } }),
    prisma.programData.findMany({ orderBy: { id: "asc" } }),
    prisma.programDataAlternative.findMany({ orderBy: { id: "asc" } }),
    prisma.importAlias.findMany({ orderBy: { id: "asc" } }),
    prisma.systemSetting.findUnique({ where: { id: 1 } }),
  ]);

  const zip = new JSZip();
  zip.file(
    "backup_metadata.json",
    JSON.stringify(
      {
        version: process.env.APP_VERSION || "0.0.0",
        kind: "config" satisfies BackupKind,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  zip.file("product_types.json", JSON.stringify(productTypes, null, 2));
  zip.file("region_data.json", JSON.stringify(regionData, null, 2));
  zip.file("training_data.json", JSON.stringify(trainingData, null, 2));
  zip.file("olx_sub_item_relations.json", JSON.stringify(olxSubItemRelations, null, 2));
  zip.file("programs.json", JSON.stringify(programs, null, 2));
  zip.file("program_tiers.json", JSON.stringify(programTiers, null, 2));
  zip.file("specialisations.json", JSON.stringify(specialisations, null, 2));
  zip.file("program_data.json", JSON.stringify(programData, null, 2));
  zip.file("program_data_alternatives.json", JSON.stringify(programDataAlternatives, null, 2));
  zip.file("import_aliases.json", JSON.stringify(importAliases, null, 2));
  zip.file("system_setting.json", JSON.stringify(systemSetting, null, 2));

  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return { buffer, timestamp };
}

/**
 * Mirror of {@link generateBackupArchive} for config-only backups. Wraps
 * {@link generateConfigZip} with envelope encryption when ENCRYPTION_KEY is
 * configured.
 */
export async function generateConfigArchive(): Promise<{
  buffer: Buffer;
  timestamp: string;
  filename: string;
  encrypted: boolean;
  contentType: string;
}> {
  const { buffer, timestamp } = await generateConfigZip();
  const zipBuf = Buffer.from(buffer);
  if (isEncryptionConfigured()) {
    const enc = encryptBuffer(zipBuf);
    return {
      buffer: enc,
      timestamp,
      filename: `training-tracker-config-${timestamp}.zip.enc`,
      encrypted: true,
      contentType: "application/octet-stream",
    };
  }
  return {
    buffer: zipBuf,
    timestamp,
    filename: `training-tracker-config-${timestamp}.zip`,
    encrypted: false,
    contentType: "application/zip",
  };
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
  const passphrase = (formData.get("passphrase") as string | null) || undefined;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  let zipBytes: Buffer;
  try {
    zipBytes = await loadBackupArchive(arrayBuffer, passphrase);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read archive" },
      { status: 400 }
    );
  }
  const zip = await JSZip.loadAsync(zipBytes);

  // Detect archive kind from metadata so we can route config-only backups to
  // the partial-restore path that leaves Student/TrainingTaken untouched.
  let kind: BackupKind = "full";
  const metaFile = zip.file("backup_metadata.json");
  if (metaFile) {
    try {
      const meta = JSON.parse(await metaFile.async("string"));
      if (meta && meta.kind === "config") kind = "config";
    } catch {
      // Unparseable metadata falls through to the full-restore validation,
      // which will reject it with a clearer "missing students.json" error.
    }
  }

  if (kind === "config") {
    return restoreConfigArchive(zip);
  }

  // Validate required files exist (full restore)
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

  const importAliasesFile = zip.file("import_aliases.json");
  const importAliases = importAliasesFile
    ? await readJson("import_aliases.json")
    : [];

  // Restore inside a transaction: wipe then re-insert in FK order
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.productType.deleteMany({});
    await tx.regionData.deleteMany({});
    await tx.importMetadata.deleteMany({});
    await tx.importAlias.deleteMany({});
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
    if (importAliases.length > 0) {
      const aliasRows = importAliases.map(
        ({
          id: _id,
          createdAt,
          ...rest
        }: {
          id: number;
          targetField: string;
          alias: string;
          createdAt: string;
        }) => ({
          ...rest,
          createdAt: createdAt ? new Date(createdAt) : new Date(),
        })
      );
      await tx.importAlias.createMany({ data: aliasRows });
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
      importAliases: importAliases.length,
    },
  });
}

/**
 * Restore a config-only archive. Replaces the reference dataset (training
 * catalogue, regions, programs, specialisations, OLX relations, import aliases,
 * system settings) without touching Student or TrainingTaken — so a populated
 * target system keeps its learner data, and a blank target gets a complete
 * seed.
 *
 * FK strategy:
 *  - ProductType, RegionData, TrainingData are FK targets for TrainingTaken /
 *    Student, so they're upserted in place (delete would violate FKs). Product
 *    types are matched by `name` because primary-key ids differ across systems;
 *    a name → id translation map rewrites training-data references.
 *  - Specialisation, ProgramData, ProgramDataAlternative, OlxSubItemRelation,
 *    ImportAlias have no incoming FKs from Student/TrainingTaken, so they're
 *    wiped and recreated with explicit ids preserved (the autoincrement
 *    sequences are reset afterwards to avoid collisions on the next insert).
 *  - SystemSetting is a singleton — upserted on id=1.
 */
async function restoreConfigArchive(zip: JSZip): Promise<NextResponse> {
  const requiredFiles = [
    "product_types.json",
    "region_data.json",
    "training_data.json",
    "specialisations.json",
    "program_data.json",
    "program_data_alternatives.json",
    "olx_sub_item_relations.json",
    "import_aliases.json",
  ];
  for (const name of requiredFiles) {
    if (!zip.file(name)) {
      return NextResponse.json(
        { error: `Invalid config backup: missing ${name}` },
        { status: 400 }
      );
    }
  }

  const readJson = async <T>(name: string): Promise<T> => {
    const file = zip.file(name);
    if (!file) return [] as unknown as T;
    return JSON.parse(await file.async("string")) as T;
  };

  type ProductTypeRow = { id: number; name: string; color: string | null };
  type RegionDataRow = { country: string; region: string; theatre: string | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TrainingDataRow = any;
  type OlxRelationRow = { parentTrainingTitle: string; subItemTrainingTitle: string };
  type SpecialisationRow = { id: number; name: string };
  type ProgramRow = { id: number; name: string; isTiered?: boolean; deploymentMode?: string; createdAt?: string };
  type ProgramTierRow = {
    id: number;
    programName: string;
    name: string;
    sortOrder: number;
    specialisationsRequired: number;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ProgramDataRow = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ProgramDataAlternativeRow = any;
  type ImportAliasRow = { id: number; targetField: string; alias: string; createdAt: string };
  type SystemSettingRow = { id: number; dateFormat: string; updatedAt: string; updatedById: number | null } | null;

  const archiveProductTypes = await readJson<ProductTypeRow[]>("product_types.json");
  const archiveRegionData = await readJson<RegionDataRow[]>("region_data.json");
  const archiveTrainingData = await readJson<TrainingDataRow[]>("training_data.json");
  const archiveOlxRelations = await readJson<OlxRelationRow[]>("olx_sub_item_relations.json");
  const archivePrograms = await readJson<ProgramRow[]>("programs.json");
  // program_tiers.json is optional — older config archives predate tiers.
  const archiveProgramTiers = await readJson<ProgramTierRow[]>("program_tiers.json");
  const archiveSpecialisations = await readJson<SpecialisationRow[]>("specialisations.json");
  const archiveProgramData = await readJson<ProgramDataRow[]>("program_data.json");
  const archiveProgramDataAlternatives = await readJson<ProgramDataAlternativeRow[]>(
    "program_data_alternatives.json"
  );
  const archiveImportAliases = await readJson<ImportAliasRow[]>("import_aliases.json");
  const systemSettingFile = zip.file("system_setting.json");
  const archiveSystemSetting: SystemSettingRow = systemSettingFile
    ? JSON.parse(await systemSettingFile.async("string"))
    : null;

  // Map archive product-type id → name so we can rewrite training-data
  // references after we resolve each name to the *target* system's id.
  const archiveProductNameById = new Map<number, string>();
  for (const pt of archiveProductTypes) {
    archiveProductNameById.set(pt.id, pt.name);
  }

  try {
    await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      // 1. Wipe the tables we'll rebuild from scratch. None of these are FK
      //    targets of Student or TrainingTaken, so it's safe to clear them.
      //    Order respects the remaining FKs inside this scope.
      await tx.programDataAlternative.deleteMany({});
      await tx.programData.deleteMany({});
      await tx.programTier.deleteMany({});
      await tx.program.deleteMany({});
      await tx.specialisation.deleteMany({});
      await tx.olxSubItemRelation.deleteMany({});
      await tx.importAlias.deleteMany({});

      // 2. Upsert ProductType by name. Existing rows keep their ids (so any
      //    TrainingData rows still pointing at them remain valid); new rows get
      //    fresh ids. Build a name → id map for the training-data step.
      const productTypeIdByName = new Map<string, number>();
      for (const pt of archiveProductTypes) {
        const trimmedName = (pt.name ?? "").trim();
        if (!trimmedName) continue;
        const upserted = await tx.productType.upsert({
          where: { name: trimmedName },
          create: { name: trimmedName, color: pt.color ?? null },
          update: { color: pt.color ?? null },
        });
        productTypeIdByName.set(trimmedName, upserted.id);
      }

      // 3. Upsert RegionData by country (PK).
      for (const row of archiveRegionData) {
        await tx.regionData.upsert({
          where: { country: row.country },
          create: { country: row.country, region: row.region, theatre: row.theatre ?? null },
          update: { region: row.region, theatre: row.theatre ?? null },
        });
      }

      // 4. Upsert TrainingData by trainingTitle (PK). Translate productTypeId
      //    via the archive id → name → target id chain. If we can't resolve
      //    (e.g. orphaned reference), fall back to any existing id on the row.
      for (const row of archiveTrainingData) {
        const archiveName = archiveProductNameById.get(row.productTypeId);
        const targetProductTypeId = archiveName
          ? productTypeIdByName.get(archiveName.trim())
          : undefined;
        if (targetProductTypeId === undefined) {
          throw new Error(
            `Training "${row.trainingTitle}" references an unknown product type — archive may be corrupt.`
          );
        }
        const writable = {
          fullTitle: row.fullTitle,
          trainingType: row.trainingType,
          productTypeId: targetProductTypeId,
          function: row.function,
          link: row.link ?? null,
          certification: row.certification ?? [],
          isIncomplete: row.isIncomplete ?? false,
          isLegacy: row.isLegacy ?? false,
          replacedBy: row.replacedBy ?? [],
        };
        await tx.trainingData.upsert({
          where: { trainingTitle: row.trainingTitle },
          create: { trainingTitle: row.trainingTitle, ...writable },
          update: writable,
        });
      }

      // 5. Re-insert OLX relations now that both sides exist in TrainingData.
      if (archiveOlxRelations.length > 0) {
        await tx.olxSubItemRelation.createMany({
          data: archiveOlxRelations.map((r) => ({
            parentTrainingTitle: r.parentTrainingTitle,
            subItemTrainingTitle: r.subItemTrainingTitle,
          })),
          skipDuplicates: true,
        });
      }

      // 6. Re-insert the Program registry. Older config archives predate the
      //    programs table, so fall back to the distinct program names referenced
      //    by the requirements to keep the registry consistent.
      if (archivePrograms.length > 0) {
        await tx.program.createMany({
          data: archivePrograms.map((p) => ({
            id: p.id,
            name: p.name,
            isTiered: p.isTiered ?? false,
            deploymentMode: p.deploymentMode ?? "flat",
            createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
          })),
        });
      } else {
        const derivedNames = [...new Set(archiveProgramData.map((p) => p.programName).filter(Boolean))];
        if (derivedNames.length > 0) {
          await tx.program.createMany({ data: derivedNames.map((name) => ({ name })) });
        }
      }

      // 6a. Re-insert ProgramTiers (after the programs they reference, before
      //     ProgramData so its tier_id FK resolves). Explicit ids preserved.
      if (archiveProgramTiers.length > 0) {
        await tx.programTier.createMany({
          data: archiveProgramTiers.map((t) => ({
            id: t.id,
            programName: t.programName,
            name: t.name,
            sortOrder: t.sortOrder,
            specialisationsRequired: t.specialisationsRequired,
          })),
        });
      }

      // 6b. Re-insert Specialisation, ProgramData, ProgramDataAlternative with
      //    explicit ids preserved so internal FKs (ProgramData.specialisationId
      //    and ProgramDataAlternative.programDataId) match the archive.
      if (archiveSpecialisations.length > 0) {
        await tx.specialisation.createMany({
          data: archiveSpecialisations.map((s) => ({ id: s.id, name: s.name })),
        });
      }
      if (archiveProgramData.length > 0) {
        await tx.programData.createMany({
          data: archiveProgramData.map((p) => ({
            id: p.id,
            programName: p.programName,
            specialisationId: p.specialisationId ?? null,
            tierId: p.tierId ?? null,
            purpose: p.purpose ?? "qualification",
            level: p.level,
            trainingType: p.trainingType ?? null,
            trainingTitle: p.trainingTitle ?? null,
            quantityRequired: p.quantityRequired,
            minimumPerTheatre: p.minimumPerTheatre ?? null,
            createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
            updatedAt: p.updatedAt ? new Date(p.updatedAt) : new Date(),
          })),
        });
      }
      if (archiveProgramDataAlternatives.length > 0) {
        await tx.programDataAlternative.createMany({
          data: archiveProgramDataAlternatives.map((a) => ({
            id: a.id,
            programDataId: a.programDataId,
            trainingType: a.trainingType,
            trainingTitle: a.trainingTitle,
          })),
        });
      }

      // 7. Reset autoincrement sequences for the tables we inserted with
      //    explicit ids, otherwise the next admin-created row will collide.
      const resetSequence = async (table: string) => {
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
        );
      };
      await resetSequence("programs");
      await resetSequence("program_tiers");
      await resetSequence("specialisations");
      await resetSequence("program_data");
      await resetSequence("program_data_alternatives");
      await resetSequence("product_types");

      // 8. Re-insert ImportAliases (id stripped so Postgres assigns fresh ones).
      if (archiveImportAliases.length > 0) {
        await tx.importAlias.createMany({
          data: archiveImportAliases.map((a) => ({
            targetField: a.targetField,
            alias: a.alias,
            createdAt: a.createdAt ? new Date(a.createdAt) : new Date(),
          })),
        });
      }

      // 9. Upsert SystemSetting singleton (id=1). The updatedById is reset to
      //    NULL so we don't dangle a FK to a user that doesn't exist on this
      //    system.
      if (archiveSystemSetting) {
        await tx.systemSetting.upsert({
          where: { id: 1 },
          create: {
            id: 1,
            dateFormat: archiveSystemSetting.dateFormat,
            updatedById: null,
          },
          update: {
            dateFormat: archiveSystemSetting.dateFormat,
            updatedById: null,
          },
        });
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Config restore failed" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    kind: "config" satisfies BackupKind,
    counts: {
      productTypes: archiveProductTypes.length,
      regionData: archiveRegionData.length,
      trainingData: archiveTrainingData.length,
      olxSubItemRelations: archiveOlxRelations.length,
      specialisations: archiveSpecialisations.length,
      programData: archiveProgramData.length,
      programDataAlternatives: archiveProgramDataAlternatives.length,
      importAliases: archiveImportAliases.length,
      systemSetting: archiveSystemSetting ? 1 : 0,
    },
  });
}
