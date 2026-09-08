import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import JSZip from "jszip";
import {
  requireSuperAdmin,
  handleAuthError,
  openMfaSecret,
  sealMfaSecret,
  clearAuthCookie,
  isRequestSecure,
} from "@/lib/auth";
import { invalidateUserStatusCache } from "@/lib/user-status";
import {
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  isEncryptionConfigured,
  isPassphraseEncryptedBuffer,
  decryptBufferWithPassphrase,
} from "@/lib/crypto";
import { prepareBackupRestore } from "@/lib/product-types";
import { invalidateSystemSettingsCache } from "@/lib/system-settings";

// Backup archive variants. A "full" backup is the historical shape (everything,
// including students and training records). A "config" backup is the reference
// dataset only — the catalogue, programs, regions, etc. — for seeding a fresh
// system without copying learner data. The discriminator is `kind` inside
// `backup_metadata.json`; older archives without the field are treated as full.
export type BackupKind = "full" | "config";

/**
 * Options shared by the backup writers.
 *
 * `includeCredentials` opts the archive in to carrying `passwordHash` and
 * `mfaSecret`. It is off by default and is only ever honoured for an archive
 * that will actually be encrypted — see {@link generateBackupArchive}, which
 * drops the request rather than trusting its caller. Without it a restore
 * cannot recreate user accounts at all (that is the whole point of the flag),
 * but with it the archive is equivalent to the password database.
 */
export interface BackupOptions {
  includeCredentials?: boolean;
}

/**
 * Wraps generateBackupZip with envelope encryption (AES-256-GCM, keyed by
 * ENCRYPTION_KEY) when configured. Returns the bytes ready to write to disk
 * or stream to the client, plus the filename that should be used (the
 * ".zip.enc" suffix is the on-disk discriminator; isEncryptedBuffer() is the
 * authoritative check during restore).
 *
 * Credentials are gated *here* rather than at each call site: this is the one
 * function that knows whether the output ends up encrypted, so no caller can
 * accidentally produce a plaintext zip full of password hashes.
 */
export async function generateBackupArchive(opts: BackupOptions = {}): Promise<{
  buffer: Buffer;
  timestamp: string;
  filename: string;
  encrypted: boolean;
  contentType: string;
  includedCredentials: boolean;
}> {
  const encrypting = isEncryptionConfigured();
  const includeCredentials = !!opts.includeCredentials && encrypting;
  const { buffer, timestamp } = await generateBackupZip({ includeCredentials });
  const zipBuf = Buffer.from(buffer);
  if (encrypting) {
    const enc = encryptBuffer(zipBuf);
    return {
      buffer: enc,
      timestamp,
      filename: `training-tracker-backup-${timestamp}.zip.enc`,
      encrypted: true,
      contentType: "application/octet-stream",
      includedCredentials: includeCredentials,
    };
  }
  return {
    buffer: zipBuf,
    timestamp,
    filename: `training-tracker-backup-${timestamp}.zip`,
    encrypted: false,
    contentType: "application/zip",
    includedCredentials: false,
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

export async function generateBackupZip(opts: BackupOptions = {}): Promise<{
  buffer: ArrayBuffer;
  timestamp: string;
}> {
  const includeCredentials = !!opts.includeCredentials;
  const [
    productTypes,
    regionData,
    trainingData,
    students,
    trainingTaken,
    importMetadata,
    users,
    importAliases,
    olxSubItemRelations,
    programs,
    programTiers,
    specialisations,
    programData,
    programDataAlternatives,
    offerings,
    offeringSpecialisations,
    offeringData,
    offeringDataAlternatives,
    companies,
    userCompanies,
  ] = await Promise.all([
    prisma.productType.findMany({ orderBy: { id: "asc" } }),
    prisma.regionData.findMany({ orderBy: { country: "asc" } }),
    prisma.trainingData.findMany({ orderBy: { trainingTitle: "asc" } }),
    prisma.student.findMany({ orderBy: { email: "asc" } }),
    prisma.trainingTaken.findMany({ orderBy: { id: "asc" } }),
    prisma.importMetadata.findMany(),
    prisma.user.findMany({ orderBy: { id: "asc" } }),
    prisma.importAlias.findMany({ orderBy: { id: "asc" } }),
    prisma.olxSubItemRelation.findMany({ orderBy: [{ parentTrainingTitle: "asc" }, { subItemTrainingTitle: "asc" }] }),
    prisma.program.findMany({ orderBy: { id: "asc" } }),
    prisma.programTier.findMany({ orderBy: { id: "asc" } }),
    prisma.specialisation.findMany({ orderBy: { id: "asc" } }),
    prisma.programData.findMany({ orderBy: { id: "asc" } }),
    prisma.programDataAlternative.findMany({ orderBy: { id: "asc" } }),
    prisma.offering.findMany({ orderBy: { id: "asc" } }),
    prisma.offeringSpecialisation.findMany({ orderBy: [{ offeringId: "asc" }, { specialisationId: "asc" }] }),
    prisma.offeringData.findMany({ orderBy: { id: "asc" } }),
    prisma.offeringDataAlternative.findMany({ orderBy: { id: "asc" } }),
    prisma.company.findMany({ orderBy: { id: "asc" } }),
    prisma.userCompany.findMany({ orderBy: [{ userId: "asc" }, { companyId: "asc" }] }),
  ]);

  const zip = new JSZip();
  zip.file(
    "backup_metadata.json",
    JSON.stringify(
      {
        version: process.env.APP_VERSION || "0.0.0",
        kind: "full" satisfies BackupKind,
        createdAt: new Date().toISOString(),
        // Authoritative signal for the restore side. Archives written before
        // this field existed omit it, which reads back as false — exactly the
        // truth for them, since they were always credential-stripped.
        includesCredentials: includeCredentials,
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
  // Reference/config tables (Programs + Offerings) are included in full backups
  // too, so a full restore rebuilds them (see restoreReferenceData).
  zip.file("olx_sub_item_relations.json", JSON.stringify(olxSubItemRelations, null, 2));
  zip.file("programs.json", JSON.stringify(programs, null, 2));
  zip.file("program_tiers.json", JSON.stringify(programTiers, null, 2));
  zip.file("specialisations.json", JSON.stringify(specialisations, null, 2));
  zip.file("program_data.json", JSON.stringify(programData, null, 2));
  zip.file("program_data_alternatives.json", JSON.stringify(programDataAlternatives, null, 2));
  zip.file("offerings.json", JSON.stringify(offerings, null, 2));
  zip.file("offering_specialisations.json", JSON.stringify(offeringSpecialisations, null, 2));
  zip.file("offering_data.json", JSON.stringify(offeringData, null, 2));
  zip.file("offering_data_alternatives.json", JSON.stringify(offeringDataAlternatives, null, 2));
  // Companies and the user->company access lists. Both are required for a
  // restore to rebuild company scoping: students.json carries a companyId FK,
  // and deleting users cascades user_companies away.
  zip.file("companies.json", JSON.stringify(companies, null, 2));
  zip.file("user_companies.json", JSON.stringify(userCompanies, null, 2));
  // Credentials (password hashes, MFA secrets) are stripped unless the caller
  // explicitly opted in — and generateBackupArchive only honours that opt-in
  // for an encrypted archive. Without them a restore cannot recreate accounts,
  // so it deliberately leaves the existing ones alone instead.
  // users.mfa_secret is sealed with *this* install's ENCRYPTION_KEY. Copying the
  // sealed blob verbatim would restore an undecryptable secret onto any system
  // with a different key — locking every MFA user out permanently, which is
  // precisely what a portable backup is for. Unseal on the way out and re-seal
  // to the target's key on restore. Both helpers are no-ops without a key, so
  // this round-trips in all four key/no-key combinations.
  const usersOut = includeCredentials
    ? users.map((u: typeof users[number]) => ({
        ...u,
        mfaSecret: u.mfaSecret ? openMfaSecret(u.mfaSecret) : null,
      }))
    : users.map(({ passwordHash: _ph, mfaSecret: _ms, ...rest }: typeof users[number]) => rest);
  zip.file("users.json", JSON.stringify(usersOut, null, 2));

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
    offerings,
    offeringSpecialisations,
    offeringData,
    offeringDataAlternatives,
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
    prisma.offering.findMany({ orderBy: { id: "asc" } }),
    prisma.offeringSpecialisation.findMany({ orderBy: [{ offeringId: "asc" }, { specialisationId: "asc" }] }),
    prisma.offeringData.findMany({ orderBy: { id: "asc" } }),
    prisma.offeringDataAlternative.findMany({ orderBy: { id: "asc" } }),
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
  zip.file("offerings.json", JSON.stringify(offerings, null, 2));
  zip.file("offering_specialisations.json", JSON.stringify(offeringSpecialisations, null, 2));
  zip.file("offering_data.json", JSON.stringify(offeringData, null, 2));
  zip.file("offering_data_alternatives.json", JSON.stringify(offeringDataAlternatives, null, 2));
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

  // ?credentials=1 opts the archive in to carrying password hashes / MFA
  // secrets. generateBackupArchive ignores it unless the output is encrypted.
  const includeCredentials =
    request.nextUrl.searchParams.get("credentials") === "1";
  const { buffer, filename, contentType, includedCredentials } =
    await generateBackupArchive({ includeCredentials });

  return new NextResponse(new Blob([new Uint8Array(buffer)]), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Lets the client tell the operator what it actually got, rather than
      // what it asked for, when ENCRYPTION_KEY is not configured.
      "X-Backup-Credentials": includedCredentials ? "included" : "excluded",
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

  return restoreFullArchive(zip, request);
}

/** Per-table outcome of a full restore. */
export interface RestoreCounts {
  regionData: number;
  trainingData: number;
  students: number;
  trainingTaken: number;
  importMetadata: number;
  importAliases: number;
  programData: number;
  offerings: number;
  offeringData: number;
  /**
   * Split rather than a bare number: reporting the archive's row count as
   * "restored" is what let a restore that deleted every account and recreated
   * none be reported as a success.
   */
  users: { inArchive: number; restored: number; skipped: number };
  companies: { inArchive: number; restored: number };
  userCompanies: { inArchive: number; restored: number };
}

/**
 * Restore a full backup archive: wipe and re-insert in FK order.
 *
 * Shared by the upload route (POST, above) and the server-side restore of a
 * saved backup (backup/restore-file). Those two used to carry byte-identical
 * copies of this transaction, and the copies drifted — one grew a guard the
 * other never got, which is precisely how a restore came to delete every user
 * account and recreate none. There is one implementation now.
 *
 * Two identity rules matter here:
 *
 *  - **Users are matched by username, companies by name.** Archived
 *    autoincrement ids cannot be trusted on a populated target: an archived
 *    company id can belong to a different company locally. Rows are therefore
 *    inserted without their archived ids and the assigned ids read back, so
 *    user_companies can be rebuilt against ids that exist on *this* instance.
 *  - **No credentials means users are left alone.** An archive written without
 *    the credentials opt-in cannot recreate a working account, so deleting the
 *    live ones would be pure loss. The archive's own metadata is authoritative;
 *    archives predating that flag omit it, which reads as false — correct for
 *    them, since they were always stripped.
 */
export async function restoreFullArchive(
  zip: JSZip,
  request?: NextRequest
): Promise<NextResponse> {
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
  const readOptional = async (name: string) =>
    zip.file(name) ? await readJson(name) : [];

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

  const importMetadata = await readOptional("import_metadata.json");
  const users = await readOptional("users.json");
  const importAliases = await readOptional("import_aliases.json");
  // Companies and access lists — present in archives written from v2.81 on.
  const companies = await readOptional("companies.json");
  const userCompanies = await readOptional("user_companies.json");

  // Reference/config tables (Programs + Offerings) — present in newer full
  // backups only; older archives leave these untouched.
  const referenceArchive = await readReferenceArchive(zip);

  // Does this archive actually carry credentials? The metadata flag is the
  // authoritative answer; the per-row check is the belt-and-braces fallback,
  // since a row without a passwordHash cannot be inserted at all (the column is
  // required) and would abort the whole transaction.
  let includesCredentials = false;
  const metaFile = zip.file("backup_metadata.json");
  if (metaFile) {
    try {
      const meta = JSON.parse(await metaFile.async("string"));
      includesCredentials = meta?.includesCredentials === true;
    } catch {
      // Unparseable metadata: treat as credential-free, i.e. preserve users.
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const restorableUsers: any[] = includesCredentials
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      users.filter((u: any) => typeof u?.passwordHash === "string" && u.passwordHash)
    : [];
  const replacingUsers = restorableUsers.length > 0;

  // The metadata claims credentials but no row carries one: the archive is
  // damaged or was edited. Preserving silently would be the same invisible
  // no-op this whole change exists to remove, so say so instead.
  if (includesCredentials && !replacingUsers && users.length > 0) {
    return NextResponse.json(
      {
        error:
          "This archive says it includes user credentials, but none of its user records have one. The archive is damaged or was modified; restore a different backup.",
      },
      { status: 400 }
    );
  }

  // Replacing the user table with one that has no usable SuperAdmin would lock
  // everyone out of admin, so refuse before touching anything. The preserve
  // branch needs no such guard: it leaves the existing accounts exactly as they
  // are, so it cannot make administration any less reachable than it already is
  // — and refusing there would block a legitimate recovery.
  if (replacingUsers) {
    const archiveSuperAdmins = restorableUsers.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (u: any) => u.role === "SuperAdmin" && !u.disabledAt
    ).length;
    if (archiveSuperAdmins === 0) {
      return NextResponse.json(
        {
          error:
            "Refusing to restore: this archive contains no enabled SuperAdmin, so restoring its user accounts would leave nobody able to administer this system.",
        },
        { status: 400 }
      );
    }
  }

  let usersRestored = 0;
  let companiesRestored = 0;
  let userCompaniesRestored = 0;
  let studentsReassigned = 0;

  // Restore inside a transaction: wipe then re-insert in FK order.
  // Prisma's default interactive-transaction timeout is 5s, which a restore of
  // any real dataset can exceed — and a P2028 here would surface as the same
  // opaque failure this change is meant to eliminate.
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.productType.deleteMany({});
    await tx.regionData.deleteMany({});
    await tx.importMetadata.deleteMany({});
    await tx.importAlias.deleteMany({});
    if (replacingUsers) {
      // Cascades user_companies; only done when we can actually put accounts
      // back (see the doc comment).
      await tx.user.deleteMany({});
    }

    // Companies first: students, offerings and the access lists all FK to them.
    // Upsert by the unique name rather than deleting the table — Company is
    // RESTRICT-referenced by scheduled exports, offerings and students, so a
    // deleteMany would throw against any row we are not restoring.
    const companyIdMap = new Map<number, number>();
    for (const c of companies) {
      const row = await tx.company.upsert({
        where: { name: c.name },
        update: {},
        create: { name: c.name },
        select: { id: true },
      });
      companyIdMap.set(c.id, row.id);
      companiesRestored++;
    }
    const localCompanies = await tx.company.findMany({ select: { id: true } });
    const localCompanyIds = new Set(localCompanies.map((c) => c.id));
    const oldestCompanyId =
      localCompanies.length > 0 ? Math.min(...localCompanyIds) : null;
    // An archived id maps through the name table when we have one; otherwise
    // (an archive predating companies.json) it can only be taken at face value.
    const mapCompanyId = (cid: number | null | undefined): number | null => {
      if (cid == null) return null;
      const mapped = companyIdMap.get(cid);
      if (mapped !== undefined) return mapped;
      return localCompanyIds.has(cid) ? cid : null;
    };

    if (productTypeRows.length > 0) {
      await tx.productType.createMany({ data: productTypeRows });
    }
    if (regionData.length > 0) {
      await tx.regionData.createMany({ data: regionData });
    }
    if (trainingData.length > 0) {
      await tx.trainingData.createMany({ data: trainingData });
    }
    // Rebuild Programs + Offerings reference data (after TrainingData exists as
    // an FK target). No-op for older archives that predate these files.
    await restoreReferenceData(tx, referenceArchive, companyIdMap);
    if (students.length > 0) {
      const studentRows = students.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (st: any) => {
          const companyId = mapCompanyId(st.companyId);
          if (companyId == null) studentsReassigned++;
          // An old archive carries no companies, so its ids may name nothing
          // here. Falling back to the oldest company (the same convention the
          // offering restore already uses) keeps the restore working instead of
          // failing the whole transaction on a foreign-key violation.
          return { ...st, companyId: companyId ?? oldestCompanyId };
        }
      );
      await tx.student.createMany({ data: studentRows });
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

    if (replacingUsers) {
      const userRows = restorableUsers.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ({ id: _id, ...rest }: any) => ({
          ...rest,
          createdAt: new Date(rest.createdAt),
          updatedAt: new Date(rest.updatedAt),
          lockedUntil: rest.lockedUntil ? new Date(rest.lockedUntil) : null,
          lastLoginAt: rest.lastLoginAt ? new Date(rest.lastLoginAt) : null,
          disabledAt: rest.disabledAt ? new Date(rest.disabledAt) : null,
          // Re-seal to *this* install's key (see the unseal on the write side).
          mfaSecret: rest.mfaSecret ? sealMfaSecret(rest.mfaSecret) : null,
        })
      );
      await tx.user.createMany({ data: userRows });
      usersRestored = userRows.length;

      // createMany returns no rows, and the ids it assigned are not the
      // archived ones (those are stripped above, which keeps the sequence
      // authoritative and needs no setval). Read them back and key on the
      // unique username so the access lists point at real local users.
      const created = await tx.user.findMany({
        select: { id: true, username: true },
      });
      const idByUsername = new Map(created.map((u) => [u.username, u.id]));
      const userIdMap = new Map<number, number>();
      for (const u of restorableUsers) {
        const newId = idByUsername.get(u.username);
        if (newId !== undefined) userIdMap.set(u.id, newId);
      }

      const linkRows = userCompanies
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((l: any) => {
          const userId = userIdMap.get(l.userId);
          const companyId = mapCompanyId(l.companyId);
          return userId === undefined || companyId == null
            ? null
            : { userId, companyId };
        })
        .filter((x: { userId: number; companyId: number } | null): x is { userId: number; companyId: number } => x !== null);
      if (linkRows.length > 0) {
        await tx.userCompany.createMany({ data: linkRows, skipDuplicates: true });
        userCompaniesRestored = linkRows.length;
      }
    }
  }, { maxWait: 10_000, timeout: 120_000 });

  // A restored account's disabled state must take effect now, not up to 15s
  // later when the cached snapshot expires.
  if (usersRestored > 0) invalidateUserStatusCache();

  const counts: RestoreCounts = {
    regionData: regionData.length,
    trainingData: trainingData.length,
    students: students.length,
    trainingTaken: trainingTaken.length,
    importMetadata: importMetadata.length,
    importAliases: importAliases.length,
    programData: referenceArchive.programData.length,
    offerings: referenceArchive.offerings.length,
    offeringData: referenceArchive.offeringData.length,
    users: {
      inArchive: users.length,
      restored: usersRestored,
      skipped: users.length - usersRestored,
    },
    companies: { inArchive: companies.length, restored: companiesRestored },
    userCompanies: {
      inArchive: userCompanies.length,
      restored: userCompaniesRestored,
    },
  };

  // Say plainly when the restore could not put accounts back. This used to be
  // reported as an unqualified success, which is how the data loss stayed
  // invisible.
  const warnings: string[] = [];
  if (!replacingUsers && users.length > 0) {
    warnings.push(
      `This archive was created without user credentials, so its ${users.length} user account(s) could not be restored. Existing accounts were left untouched. To carry accounts across, take a backup with "Include user credentials" enabled.`
    );
  }
  if (studentsReassigned > 0) {
    warnings.push(
      `${studentsReassigned} student(s) referenced a company that does not exist here and were assigned to the oldest company. Review their company on the Students page.`
    );
  }

  // Replacing the user table reassigns ids, so the caller's session token now
  // names whichever account inherited its id — and requireSuperAdmin reads the
  // role from the token, not the database. Drop the cookie and make them sign
  // in again rather than leaving a session pointing at the wrong identity.
  const sessionInvalidated = usersRestored > 0;
  const response = NextResponse.json({
    success: true,
    counts,
    sessionInvalidated,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  if (sessionInvalidated && request) {
    clearAuthCookie(response, isRequestSecure(request));
  }
  return response;
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
  type OfferingRow = { id: number; companyId?: number; name: string; description: string | null; link: string | null; createdAt?: string };
  type OfferingSpecialisationRow = { offeringId?: number; offeringName?: string; specialisationId: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type OfferingDataRow = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type OfferingDataAlternativeRow = any;
  type ImportAliasRow = { id: number; targetField: string; alias: string; createdAt: string };
  // Every field is optional bar dateFormat: archives written before a given
  // setting existed simply omit it, and the upsert below falls back to the
  // column default in that case.
  type SystemSettingRow = {
    id: number;
    dateFormat: string;
    sessionIdleMinutes?: number;
    publicApiEnabled?: boolean;
    appName?: string;
    brandColor?: string | null;
    logoData?: string | null;
    logoMimeType?: string | null;
    faviconData?: string | null;
    faviconMimeType?: string | null;
    loginShowName?: boolean;
    loginShowLogo?: boolean;
    showNameInTab?: boolean;
    updatedAt: string;
    updatedById: number | null;
  } | null;

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
  // Offering files are optional — older config archives predate offerings.
  const archiveOfferings = await readJson<OfferingRow[]>("offerings.json");
  const archiveOfferingSpecialisations = await readJson<OfferingSpecialisationRow[]>(
    "offering_specialisations.json"
  );
  const archiveOfferingData = await readJson<OfferingDataRow[]>("offering_data.json");
  const archiveOfferingDataAlternatives = await readJson<OfferingDataAlternativeRow[]>(
    "offering_data_alternatives.json"
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
      // Offerings — child-first; offering_data → specialisations is ON DELETE
      // RESTRICT, so clear them before specialisation.deleteMany below.
      await tx.offeringDataAlternative.deleteMany({});
      await tx.offeringData.deleteMany({});
      await tx.offeringSpecialisation.deleteMany({});
      await tx.offering.deleteMany({});
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

      // 6c. Re-insert Offerings (parent first) then their specialisation links,
      //     requirements and alternatives. Config archives carry no companies, so
      //     offerings are assigned to the target's oldest company (an archived
      //     companyId is honoured only if that company happens to exist here);
      //     the admin can reassign them afterward. Specialisation + TrainingData
      //     already exist by now (steps 4 + 6b).
      if (archiveOfferings.length > 0) {
        const companyRows = await tx.company.findMany({ select: { id: true } });
        const existingCompanyIds = new Set(companyRows.map((c) => c.id));
        const fallbackCompanyId = companyRows.length > 0 ? Math.min(...existingCompanyIds) : null;
        const prepared = prepareOfferingInserts(
          archiveOfferings,
          archiveOfferingSpecialisations,
          archiveOfferingData,
          archiveOfferingDataAlternatives,
          existingCompanyIds,
          fallbackCompanyId
        );
        if (prepared.offeringRows.length > 0) {
          await tx.offering.createMany({ data: prepared.offeringRows });
        }
        if (prepared.specRows.length > 0) {
          await tx.offeringSpecialisation.createMany({ data: prepared.specRows, skipDuplicates: true });
        }
        if (prepared.dataRows.length > 0) {
          await tx.offeringData.createMany({ data: prepared.dataRows });
        }
        if (prepared.altRows.length > 0) {
          await tx.offeringDataAlternative.createMany({ data: prepared.altRows });
        }
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
      await resetSequence("offerings");
      await resetSequence("offering_data");
      await resetSequence("offering_data_alternatives");
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
      //    system. Every settable field is carried across — this used to write
      //    only dateFormat, which silently dropped the rest of the settings on
      //    every restore. Fields absent from an older archive are left out of
      //    the payload so the column default applies.
      if (archiveSystemSetting) {
        const s = archiveSystemSetting;
        const settingFields = {
          dateFormat: s.dateFormat,
          ...(s.sessionIdleMinutes !== undefined
            ? { sessionIdleMinutes: s.sessionIdleMinutes }
            : {}),
          ...(s.publicApiEnabled !== undefined
            ? { publicApiEnabled: s.publicApiEnabled }
            : {}),
          ...(s.appName !== undefined ? { appName: s.appName } : {}),
          ...(s.brandColor !== undefined ? { brandColor: s.brandColor } : {}),
          ...(s.logoData !== undefined ? { logoData: s.logoData } : {}),
          ...(s.logoMimeType !== undefined ? { logoMimeType: s.logoMimeType } : {}),
          ...(s.faviconData !== undefined ? { faviconData: s.faviconData } : {}),
          ...(s.faviconMimeType !== undefined
            ? { faviconMimeType: s.faviconMimeType }
            : {}),
          ...(s.loginShowName !== undefined ? { loginShowName: s.loginShowName } : {}),
          ...(s.loginShowLogo !== undefined ? { loginShowLogo: s.loginShowLogo } : {}),
          ...(s.showNameInTab !== undefined ? { showNameInTab: s.showNameInTab } : {}),
          updatedById: null,
        };
        await tx.systemSetting.upsert({
          where: { id: 1 },
          create: { id: 1, ...settingFields },
          update: settingFields,
        });
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Config restore failed" },
      { status: 400 }
    );
  }

  // The settings singleton was just rewritten underneath the 30s in-memory
  // cache, so drop it — otherwise the restored date format and branding stay
  // invisible (and the stale values keep being served) until the TTL expires.
  invalidateSystemSettingsCache();

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
      offerings: archiveOfferings.length,
      offeringData: archiveOfferingData.length,
      importAliases: archiveImportAliases.length,
      systemSetting: archiveSystemSetting ? 1 : 0,
    },
  });
}

/**
 * Reference/config data (Programs + Offerings + Specialisations + OLX relations)
 * parsed from a FULL backup archive. Full backups now carry these tables so a
 * full restore rebuilds them. Older full backups predate the files — `present`
 * is false then, and {@link restoreReferenceData} leaves the tables untouched
 * (matching the historical behaviour where full restore never touched them).
 */
export interface ReferenceArchive {
  present: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  olxRelations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  programs: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  programTiers: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  specialisations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  programData: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  programDataAlternatives: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offerings: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offeringSpecialisations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offeringData: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offeringDataAlternatives: any[];
}

/** Read the reference/config tables from a full backup zip (all optional). */
export async function readReferenceArchive(zip: JSZip): Promise<ReferenceArchive> {
  const read = async (name: string) => {
    const f = zip.file(name);
    if (!f) return [];
    return JSON.parse(await f.async("string"));
  };
  const present = !!(
    zip.file("programs.json") ||
    zip.file("offerings.json") ||
    zip.file("specialisations.json")
  );
  return {
    present,
    olxRelations: await read("olx_sub_item_relations.json"),
    programs: await read("programs.json"),
    programTiers: await read("program_tiers.json"),
    specialisations: await read("specialisations.json"),
    programData: await read("program_data.json"),
    programDataAlternatives: await read("program_data_alternatives.json"),
    offerings: await read("offerings.json"),
    offeringSpecialisations: await read("offering_specialisations.json"),
    offeringData: await read("offering_data.json"),
    offeringDataAlternatives: await read("offering_data_alternatives.json"),
  };
}

/**
 * Prepare Offering + child rows for insertion from a backup archive, tolerating
 * both new archives (each offering carries `companyId`; children reference
 * `offeringId`) and old archives predating company-scoping (no `companyId`;
 * children reference the then-globally-unique `offeringName`).
 *
 * `existingCompanyIds` is the set of company ids present on the RESTORE target;
 * an archived `companyId` is honoured when it exists there (full restore
 * re-inserts companies, so ids line up), otherwise the offering is reassigned to
 * `fallbackCompanyId` (the target's oldest company — used for config restores,
 * which carry no companies, and for old archives). Offerings that can't be
 * assigned to any company (fallback null → no companies exist) are dropped,
 * along with their children.
 */
function prepareOfferingInserts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offerings: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  specs: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alternatives: any[],
  existingCompanyIds: Set<number>,
  fallbackCompanyId: number | null
) {
  const idByName = new Map<string, number>();
  for (const o of offerings) idByName.set(o.name, o.id);
  const resolveCompany = (cid: number | null | undefined): number | null =>
    cid != null && existingCompanyIds.has(cid) ? cid : fallbackCompanyId;

  const offeringRows = offerings
    .map((o) => {
      const companyId = resolveCompany(o.companyId);
      if (companyId == null) return null;
      return {
        id: o.id,
        companyId,
        name: o.name,
        description: o.description ?? null,
        link: o.link ?? null,
        createdAt: o.createdAt ? new Date(o.createdAt) : new Date(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const validOfferingIds = new Set(offeringRows.map((o) => o.id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveOfferingId = (r: any): number | null => {
    const id = r.offeringId ?? (r.offeringName != null ? idByName.get(r.offeringName) : undefined);
    return id != null && validOfferingIds.has(id) ? id : null;
  };

  const specRows = specs
    .map((s) => {
      const offeringId = resolveOfferingId(s);
      return offeringId == null ? null : { offeringId, specialisationId: s.specialisationId };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const dataRows = data
    .map((o) => {
      const offeringId = resolveOfferingId(o);
      return offeringId == null
        ? null
        : {
            id: o.id,
            offeringId,
            specialisationId: o.specialisationId,
            trainingType: o.trainingType ?? null,
            trainingTitle: o.trainingTitle ?? null,
            quantityRequired: o.quantityRequired,
            createdAt: o.createdAt ? new Date(o.createdAt) : new Date(),
            updatedAt: o.updatedAt ? new Date(o.updatedAt) : new Date(),
          };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const validDataIds = new Set(dataRows.map((d) => d.id));
  const altRows = alternatives
    .filter((a) => validDataIds.has(a.offeringDataId))
    .map((a) => ({
      id: a.id,
      offeringDataId: a.offeringDataId,
      trainingType: a.trainingType,
      trainingTitle: a.trainingTitle,
    }));

  return { offeringRows, specRows, dataRows, altRows };
}

/**
 * Rebuild the reference/config tables inside a full-restore transaction. Must be
 * called AFTER TrainingData has been (re)inserted, since program/offering
 * requirements and OLX relations FK to training_data. No-op when the archive
 * predates these files, so old full backups restore exactly as before.
 */
export async function restoreReferenceData(
  tx: PrismaTransactionClient,
  a: ReferenceArchive,
  /**
   * archived company id -> local company id, from the full restore. Offerings
   * are company-scoped, so without this an archived id that was renumbered on
   * this instance would fall back to the oldest company and silently move the
   * offering to the wrong tenant. Absent for the config path, which carries no
   * companies at all.
   */
  companyIdMap?: Map<number, number>
): Promise<void> {
  if (!a.present) return;

  // Wipe child-first (offering_data / program_data → specialisations is
  // ON DELETE RESTRICT, so specialisations clear last).
  await tx.programDataAlternative.deleteMany({});
  await tx.programData.deleteMany({});
  await tx.programTier.deleteMany({});
  await tx.program.deleteMany({});
  await tx.offeringDataAlternative.deleteMany({});
  await tx.offeringData.deleteMany({});
  await tx.offeringSpecialisation.deleteMany({});
  await tx.offering.deleteMany({});
  await tx.specialisation.deleteMany({});
  await tx.olxSubItemRelation.deleteMany({});

  // Insert parent-first. Explicit ids preserved so internal FKs line up.
  if (a.olxRelations.length > 0) {
    await tx.olxSubItemRelation.createMany({
      data: a.olxRelations.map((r) => ({
        parentTrainingTitle: r.parentTrainingTitle,
        subItemTrainingTitle: r.subItemTrainingTitle,
      })),
      skipDuplicates: true,
    });
  }
  if (a.specialisations.length > 0) {
    await tx.specialisation.createMany({ data: a.specialisations.map((s) => ({ id: s.id, name: s.name })) });
  }
  if (a.programs.length > 0) {
    await tx.program.createMany({
      data: a.programs.map((p) => ({
        id: p.id,
        name: p.name,
        isTiered: p.isTiered ?? false,
        deploymentMode: p.deploymentMode ?? "flat",
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
      })),
    });
  }
  if (a.programTiers.length > 0) {
    await tx.programTier.createMany({
      data: a.programTiers.map((t) => ({
        id: t.id,
        programName: t.programName,
        name: t.name,
        sortOrder: t.sortOrder,
        specialisationsRequired: t.specialisationsRequired,
      })),
    });
  }
  if (a.programData.length > 0) {
    await tx.programData.createMany({
      data: a.programData.map((p) => ({
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
  if (a.programDataAlternatives.length > 0) {
    await tx.programDataAlternative.createMany({
      data: a.programDataAlternatives.map((x) => ({
        id: x.id,
        programDataId: x.programDataId,
        trainingType: x.trainingType,
        trainingTitle: x.trainingTitle,
      })),
    });
  }
  if (a.offerings.length > 0) {
    // A full restore has already reconciled companies by name (companies are
    // matched, never renumbered blindly), so translate archived ids through
    // that map first. The oldest company remains the fallback for an offering
    // whose company is missing entirely — e.g. an old archive with no companyId.
    const companyRows = await tx.company.findMany({ select: { id: true } });
    const existingCompanyIds = new Set(companyRows.map((c) => c.id));
    const fallbackCompanyId = companyRows.length > 0 ? Math.min(...existingCompanyIds) : null;
    const mappedOfferings = companyIdMap
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        a.offerings.map((o: any) => ({
          ...o,
          companyId:
            o.companyId != null ? companyIdMap.get(o.companyId) ?? o.companyId : o.companyId,
        }))
      : a.offerings;
    const prepared = prepareOfferingInserts(
      mappedOfferings,
      a.offeringSpecialisations,
      a.offeringData,
      a.offeringDataAlternatives,
      existingCompanyIds,
      fallbackCompanyId
    );
    if (prepared.offeringRows.length > 0) {
      await tx.offering.createMany({ data: prepared.offeringRows });
    }
    if (prepared.specRows.length > 0) {
      await tx.offeringSpecialisation.createMany({ data: prepared.specRows, skipDuplicates: true });
    }
    if (prepared.dataRows.length > 0) {
      await tx.offeringData.createMany({ data: prepared.dataRows });
    }
    if (prepared.altRows.length > 0) {
      await tx.offeringDataAlternative.createMany({ data: prepared.altRows });
    }
  }

  // Reset autoincrement sequences for tables inserted with explicit ids.
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
  await resetSequence("offerings");
  await resetSequence("offering_data");
  await resetSequence("offering_data_alternatives");
}
