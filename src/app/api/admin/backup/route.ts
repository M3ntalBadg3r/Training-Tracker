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
  verifyPassword,
  verifyMfaToken,
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
import { normaliseAggregation } from "@/lib/program-levels";
import { invalidateSystemSettingsCache } from "@/lib/system-settings";
import { invalidateReportCache } from "@/lib/report-cache";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// Backup archive variants. A "full" backup is the historical shape (everything,
// including students and training records). A "config" backup is the reference
// dataset only — the catalogue, programs, regions, etc. — for seeding a fresh
// system without copying learner data. The discriminator is `kind` inside
// `backup_metadata.json`; older archives without the field are treated as full.
export type BackupKind = "full" | "config";

// Upper bound on an uploaded archive before it is buffered into memory and
// expanded by JSZip. A real full backup of a large install is well under this;
// the cap exists to stop an unbounded upload (or a zip-bomb's compressed
// payload) from exhausting memory on the restore path. Override for unusually
// large datasets via BACKUP_MAX_RESTORE_MB.
export const MAX_RESTORE_UPLOAD_BYTES =
  Math.max(1, Number(process.env.BACKUP_MAX_RESTORE_MB) || 512) * 1024 * 1024;

/**
 * Upper bound on an archive's *decompressed* size.
 *
 * MAX_RESTORE_UPLOAD_BYTES bounds only what arrives on the wire, which a
 * compressed archive can multiply without limit — and every entry the restore
 * cares about is then read to a string and JSON.parsed, multiplying it again.
 *
 * The default is measured, not guessed. A real full backup of a populated
 * database (500 students, 4,750 training records, credentials included) expands
 * to **0.96 MB**, so 1024 MB is roughly a thousand times a realistic archive and
 * still several times the largest install that could plausibly exist. It is
 * also unreachable by honest data for a second reason: JSZip writes these
 * archives with no compression (verified — the inner zip's byte length equals
 * the sum of its entries' uncompressed sizes), so a genuine archive expands
 * about 1:1 and one that passed the 512 MB upload cap cannot exceed it. Only
 * something that compresses heavily can, which is exactly what this refuses.
 * Override with BACKUP_MAX_EXPANDED_MB.
 */
export const MAX_EXPANDED_ARCHIVE_BYTES =
  Math.max(1, Number(process.env.BACKUP_MAX_EXPANDED_MB) || 1024) * 1024 * 1024;

/**
 * Ceiling for `User.sessionEpoch`, which is a Postgres `integer`. Used to clamp
 * the restore's epoch floor so a hostile or corrupt archived value cannot make
 * the write overflow the column.
 */
const MAX_SESSION_EPOCH = 2147483647;

/** JSZip records each entry's central-directory size here at loadAsync time. */
interface ZipEntryInternals {
  _data?: { uncompressedSize?: unknown };
}

/**
 * Refuse an archive whose entries decompress to more than
 * MAX_EXPANDED_ARCHIVE_BYTES. Returns a ready response, or null to proceed.
 *
 * JSZip fills `_data.uncompressedSize` from the central directory during
 * `loadAsync`, before anything is inflated, so this is a cheap header read
 * rather than a streaming count. An entry whose size cannot be read is treated
 * as **unbounded, not zero**, and refuses the archive: a size we cannot see is
 * a size we cannot cap, and silently counting it as 0 would reopen the hole for
 * exactly the crafted archive this exists to stop. If a future JSZip moves the
 * field, every restore fails loudly with this message — which is the right way
 * round for a guard.
 */
export function checkExpandedArchiveSize(zip: JSZip): NextResponse | null {
  const tooLarge = () =>
    NextResponse.json(
      { error: "Backup archive is too large to restore." },
      { status: 413 }
    );
  let total = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const size = (entry as unknown as ZipEntryInternals)._data?.uncompressedSize;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      console.warn(
        `[backup] refusing archive: entry "${name}" reports no decompressed size`
      );
      return tooLarge();
    }
    total += size;
    if (total > MAX_EXPANDED_ARCHIVE_BYTES) {
      console.warn(
        `[backup] refusing archive: entries decompress to more than ${MAX_EXPANDED_ARCHIVE_BYTES} bytes`
      );
      return tooLarge();
    }
  }
  return null;
}

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
 * Step-up re-authentication for a restore. A restore replaces the entire
 * dataset — and a credential-bearing one replaces every account's password —
 * so it must not be triggerable by a hijacked cookie alone (threat 1: a phished
 * Admin). The caller has already passed `requireSuperAdmin`; this re-verifies
 * their *own* password, plus a current TOTP code when their account has MFA,
 * mirroring the step-up on the admin password-reset and MFA-disable routes.
 * Returns a ready error response, or null when the challenge passes.
 */
export async function requireRestoreStepUp(
  request: NextRequest,
  userId: number,
  password: string | undefined,
  mfaCode: string | undefined
): Promise<NextResponse | null> {
  if (!password) {
    return NextResponse.json(
      { error: "Your current password is required to restore a backup" },
      { status: 400 }
    );
  }

  // Rate-limited here rather than in the two callers, so a third restore path
  // cannot be added without one. A step-up prompt is a password-guessing
  // surface like any other; every other route that verifies a password is
  // limited, and this one was not.
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`restore-stepup:${userId}:${ip}`, 5, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      }
    );
  }
  const me = await prisma.user.findUnique({ where: { id: userId } });
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const passwordValid = await verifyPassword(password, me.passwordHash);
  if (!passwordValid) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  if (me.mfaEnabled && me.mfaSecret) {
    if (!mfaCode || !verifyMfaToken(me.mfaSecret, mfaCode)) {
      return NextResponse.json({ error: "MFA code required" }, { status: 401 });
    }
  }
  return null;
}

/**
 * Decrypt-if-needed loader for a backup archive. Accepts:
 *  - a raw ZIP buffer (legacy / unencrypted deployments),
 *  - a key-encrypted buffer (magic 'TT01' + IV + tag + ciphertext), keyed by
 *    this install's ENCRYPTION_KEY, or
 *  - a portable, passphrase-encrypted buffer (magic 'TT02' + salt + IV + tag +
 *    ciphertext) — restorable on any system given the original passphrase.
 * Returns the inner ZIP bytes ready for JSZip.loadAsync, plus whether the
 * input was actually encrypted (TT01 key-encrypted or TT02 passphrase). That
 * flag is the authority for whether a credential-bearing restore may proceed:
 * the write side only ever stamps `includesCredentials` on an archive it
 * encrypted (see the contract on BackupOptions and generateBackupArchive), so
 * a *plaintext* zip claiming to carry credentials is always crafted or
 * corrupt. Honouring that flag off an unencrypted archive is a full
 * instance-takeover primitive — an attacker's `users.json` with a chosen
 * `passwordHash` would replace every account — so the restore paths refuse it.
 */
export async function loadBackupArchive(
  input: ArrayBuffer | Buffer,
  passphrase?: string
): Promise<{ bytes: Buffer; encrypted: boolean }> {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (isPassphraseEncryptedBuffer(buf)) {
    if (!passphrase) {
      throw new Error(
        "This is a portable backup. Enter the passphrase it was created with to restore it."
      );
    }
    return { bytes: decryptBufferWithPassphrase(buf, passphrase), encrypted: true };
  }
  if (isEncryptedBuffer(buf)) {
    if (!isEncryptionConfigured()) {
      throw new Error(
        "Archive is encrypted but ENCRYPTION_KEY is not configured. Set ENCRYPTION_KEY to the same value used when the backup was created, or restore a portable backup instead."
      );
    }
    return { bytes: decryptBuffer(buf), encrypted: true };
  }
  return { bytes: buf, encrypted: false };
}

/**
 * Country Sets as both archive kinds write them: the stored row plus
 * `companyName`. Sets are company-scoped, and an archived `companyId` is only
 * meaningful beside the companies.json it indexes — which a config archive does
 * not carry — so the name rides in every row and both restore paths resolve
 * through one rule (see {@link countrySetCompanyResolver}).
 */
async function findCountrySetsForArchive() {
  const rows = await prisma.countrySet.findMany({
    orderBy: { id: "asc" },
    include: { company: { select: { name: true } } },
  });
  return rows.map(({ company, ...rest }) => ({ ...rest, companyName: company.name }));
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
    countrySets,
    countrySetMembers,
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
    findCountrySetsForArchive(),
    prisma.countrySetMember.findMany({ orderBy: [{ countrySetId: "asc" }, { country: "asc" }] }),
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
  // Country Sets (each company's own groupings of Region Data countries).
  // Deliberately NOT part of ReferenceArchive — see restoreCountrySets for why.
  // Rows carry both `companyId` (mapped through companies.json on restore) and
  // `companyName` (the fallback when the id does not map).
  zip.file("country_sets.json", JSON.stringify(countrySets, null, 2));
  zip.file("country_set_members.json", JSON.stringify(countrySetMembers, null, 2));
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
    countrySets,
    countrySetMembers,
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
    findCountrySetsForArchive(),
    prisma.countrySetMember.findMany({ orderBy: [{ countrySetId: "asc" }, { country: "asc" }] }),
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
  // Country Sets are reference data (groupings of RegionData countries), so a
  // config backup carries them too. They are per-company, and a config archive
  // has no companies.json, so the archived companyId means nothing on another
  // install: each row carries `companyName`, which is what the restore matches.
  zip.file("country_sets.json", JSON.stringify(countrySets, null, 2));
  zip.file("country_set_members.json", JSON.stringify(countrySetMembers, null, 2));

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
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const passphrase = (formData.get("passphrase") as string | null) || undefined;
  const password = (formData.get("password") as string | null) || undefined;
  const mfaCode = (formData.get("mfaCode") as string | null) || undefined;

  // Step-up before any destructive read of the archive: a stolen cookie alone
  // must not be able to overwrite the dataset.
  const stepUpError = await requireRestoreStepUp(request, auth.sub, password, mfaCode);
  if (stepUpError) return stepUpError;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Cap the body before arrayBuffer() buffers the whole thing into memory — a
  // per-field check afterwards would be too late (mirrors the branding route).
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESTORE_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "Backup file is too large to restore." },
      { status: 413 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_RESTORE_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "Backup file is too large to restore." },
      { status: 413 }
    );
  }
  let zipBytes: Buffer;
  let archiveWasEncrypted = false;
  try {
    const loaded = await loadBackupArchive(arrayBuffer, passphrase);
    zipBytes = loaded.bytes;
    archiveWasEncrypted = loaded.encrypted;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read archive" },
      { status: 400 }
    );
  }
  const zip = await JSZip.loadAsync(zipBytes);
  // The upload cap above bounded the compressed bytes; this bounds what they
  // expand to, before any entry is inflated or parsed.
  const oversized = checkExpandedArchiveSize(zip);
  if (oversized) return oversized;

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

  return restoreFullArchive(zip, request, archiveWasEncrypted);
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
  /** Sets / memberships in place after the restore (see restoreCountrySets). */
  countrySets: number;
  countrySetMembers: number;
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
  request?: NextRequest,
  archiveWasEncrypted = false
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
  // Country Sets — present in newer archives only. Kept separate
  // from referenceArchive on purpose (see CountrySetArchive).
  const countrySetArchive = await readCountrySetArchive(zip);

  // Does this archive actually carry credentials? The metadata flag is the
  // authoritative answer; the per-row check is the belt-and-braces fallback,
  // since a row without a passwordHash cannot be inserted at all (the column is
  // required) and would abort the whole transaction.
  let metadataClaimsCredentials = false;
  const metaFile = zip.file("backup_metadata.json");
  if (metaFile) {
    try {
      const meta = JSON.parse(await metaFile.async("string"));
      metadataClaimsCredentials = meta?.includesCredentials === true;
    } catch {
      // Unparseable metadata: treat as credential-free, i.e. preserve users.
    }
  }

  // The credential-carrying flag is only trustworthy on an encrypted archive.
  // The write side never stamps it on a plaintext zip (see loadBackupArchive's
  // contract), so a plaintext archive that claims credentials is crafted or
  // corrupt — and honouring it would let anyone who can reach this route
  // (a SuperAdmin, or a hijacked SuperAdmin session) replace every account's
  // password hash from attacker-controlled JSON. Refuse it outright rather than
  // silently dropping the flag, so tampering is visible instead of a quiet no-op.
  if (metadataClaimsCredentials && !archiveWasEncrypted) {
    return NextResponse.json(
      {
        error:
          "This archive claims to include user credentials but is not encrypted. Credential-bearing backups are always encrypted; this archive is unencrypted, so it is corrupt or was modified. Restore will not proceed.",
      },
      { status: 400 }
    );
  }
  const includesCredentials = metadataClaimsCredentials;

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
  // Cast, not an annotation: assigned inside the transaction callback, which
  // control-flow analysis cannot see, so an annotated `= null` narrows to never.
  let countrySetResult = null as CountrySetRestoreResult | null;
  // Highest sessionEpoch among the accounts this restore is about to delete.
  // Read inside the transaction, *before* the deleteMany destroys it.
  let liveSessionEpochMax = 0;

  // Restore inside a transaction: wipe then re-insert in FK order.
  // Prisma's default interactive-transaction timeout is 5s, which a restore of
  // any real dataset can exceed — and a P2028 here would surface as the same
  // opaque failure this change is meant to eliminate.
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    // The regionData.deleteMany below cascades every Country Set membership
    // away. An archive that carries the country-set files replaces them
    // outright; one that predates them must not silently empty every live
    // set, so snapshot the memberships first and put them back afterwards.
    const liveCountrySetMembers: CountrySetMemberSnapshot[] = countrySetArchive
      ? []
      : await tx.countrySetMember.findMany({ select: { countrySetId: true, country: true } });
    await tx.trainingTaken.deleteMany({});
    await tx.student.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.productType.deleteMany({});
    await tx.regionData.deleteMany({});
    await tx.importMetadata.deleteMany({});
    await tx.importAlias.deleteMany({});
    if (replacingUsers) {
      // Capture the live session-epoch high-water mark before the delete throws
      // it away — it is the floor the restored rows have to clear (see the
      // sessionEpoch comment on userRows below).
      const liveEpochs = await tx.user.aggregate({ _max: { sessionEpoch: true } });
      liveSessionEpochMax = liveEpochs._max.sessionEpoch ?? 0;
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
    const localCompanies = await tx.company.findMany({ select: { id: true, name: true } });
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
    // Memberships FK to region_data, so this must follow the insert above.
    // Sets are company-scoped: an archived set's companyId goes through the
    // same companyIdMap the students and offerings use (built above, after the
    // company upserts), with its companyName as the fallback.
    countrySetResult = await restoreCountrySets(
      tx,
      countrySetArchive,
      liveCountrySetMembers,
      countrySetCompanyResolver(localCompanies, companyIdMap)
    );
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
      // Every restored account starts above BOTH the epochs this restore just
      // destroyed and whatever the archive claimed.
      //
      // The property the whole revocation lever rests on is that an account's
      // `sessionEpoch` never moves backwards — `isSessionEpochStale` revokes a
      // token only when its epoch is *behind* the column, so a counter that
      // decreases silently re-validates whatever was minted at the lower value.
      // Restoring users was the one operation that moved it backwards:
      // `...rest` carries the archive's own `sessionEpoch`, and an older backup
      // routinely holds a value below the live one (it predates every password
      // change and admin reset since). The floor restores the invariant.
      //
      // Note what this does *not* claim. Rows go in without their archived ids
      // and `users_id_seq` is never reset (no `resetSequence` call covers
      // `users`), so on a given database user ids only ever advance: a restored
      // row cannot take an id a previous account held, and a token issued before
      // the restore is therefore orphaned rather than re-pointed. The floor is
      // what keeps that true where the sequence is *not* ahead — a database
      // rebuilt from a dump, or the same archive restored onto another install
      // that shares this one's JWT secret — so an id that does get reused cannot
      // arrive carrying a usable lease.
      //
      // This is the one place a plain `set` is correct rather than the
      // `{ increment: 1 }` used everywhere else (users/[id], change-password,
      // reset-password). Those bump one account's own counter, which is
      // meaningful because the row's identity is unchanged. Here the rows are
      // new, their ids are reassigned, and an archived counter describes a
      // different instance's history — so per-user carry-over has no meaning and
      // only a single **global** floor is well defined. Do not "restore" this to
      // an increment: incrementing the archived value can still land below the
      // live one, which is exactly the hole.
      const archivedSessionEpochMax = restorableUsers.reduce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (max: number, u: any) =>
          typeof u?.sessionEpoch === "number" && u.sessionEpoch > max
            ? u.sessionEpoch
            : max,
        0
      );
      // Clamped to the column's type. `session_epoch` is a Postgres `integer`,
      // so an archive carrying the maximum would otherwise make the +1 overflow
      // and abort the transaction (P2020) — turning an archive that used to
      // restore into an unexplained failure. At the clamp the floor stops rising
      // and the "always above what came before" guarantee degrades to "equal
      // to", which is only reachable from an archive that already sat at the
      // ceiling, and is strictly better than refusing to restore at all.
      const sessionEpochFloor = Math.min(
        Math.max(liveSessionEpochMax, archivedSessionEpochMax) + 1,
        MAX_SESSION_EPOCH
      );

      const userRows = restorableUsers.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ({ id: _id, ...rest }: any) => ({
          ...rest,
          sessionEpoch: sessionEpochFloor,
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
  // Every report input was just replaced. After the commit, never inside the
  // callback: flushing before the commit lands lets a concurrent request
  // re-cache the pre-restore rows for a full TTL.
  invalidateReportCache();

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
    countrySets: countrySetResult?.sets ?? 0,
    countrySetMembers: countrySetResult?.members ?? 0,
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
  warnings.push(...countrySetWarnings(countrySetResult));
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
  // isoCode is optional here because archives written before the column
  // existed simply do not carry the key; it restores as null.
  type RegionDataRow = {
    country: string;
    region: string;
    theatre: string | null;
    isoCode?: string | null;
  };
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
  // Country Sets are optional (older config archives predate them) and are
  // NOT in requiredFiles: absent, the live sets are left exactly as they are.
  const archiveCountrySets = await readCountrySetArchive(zip);
  // Cast, not an annotation: assigned inside the transaction callback, which
  // control-flow analysis cannot see, so an annotated `= null` narrows to never.
  let countrySetResult = null as CountrySetRestoreResult | null;
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

      // 3. Upsert RegionData by country (PK). This path enumerates its columns
      //    explicitly (unlike the full restore's createMany, which spreads the
      //    archived row), so a new column has to be added here by hand or it is
      //    silently dropped on every config round-trip. `?? null` covers older
      //    archives that predate the column, which restore as unmapped.
      for (const row of archiveRegionData) {
        await tx.regionData.upsert({
          where: { country: row.country },
          create: {
            country: row.country,
            region: row.region,
            theatre: row.theatre ?? null,
            isoCode: row.isoCode ?? null,
          },
          update: {
            region: row.region,
            theatre: row.theatre ?? null,
            // An archive written before this column existed carries no key at
            // all, and this restore is an upsert-MERGE (it never deletes rows
            // the archive omits), so it is not authoritative about a field it
            // does not mention. `isoCode: row.isoCode ?? null` would coerce
            // that absence into an explicit NULL and wipe every operator-set
            // code on the countries the archive names — silently, while the
            // response still reports them restored. Same shape as the import
            // route's unmapped-column rule, and the same reason.
            ...(Object.prototype.hasOwnProperty.call(row, "isoCode")
              ? { isoCode: row.isoCode ?? null }
              : {}),
          },
        });
      }

      // 3a. Country Sets. Region data is upserted and never deleted here, so
      //     live memberships survive; the sets are only replaced when the
      //     archive carries them. After step 3 so every member's country FK
      //     target exists.
      //     A config archive carries no companies.json, so each set finds its
      //     company by name among the companies that exist here.
      countrySetResult = await restoreCountrySets(
        tx,
        archiveCountrySets,
        [],
        countrySetCompanyResolver(
          await tx.company.findMany({ select: { id: true, name: true } })
        )
      );

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
          isIgnored: row.isIgnored ?? false,
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
            // Older archives predate the column; normalising also stops a
            // hand-edited value tripping the aggregation CHECK constraints.
            aggregation: normaliseAggregation(p.level, p.aggregation),
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
  // Catalogue, programs, regions and Country Sets all feed the reports. After
  // the commit, for the same reason as the full restore.
  invalidateReportCache();

  const configWarnings: string[] = countrySetWarnings(countrySetResult);

  return NextResponse.json({
    success: true,
    kind: "config" satisfies BackupKind,
    ...(configWarnings.length > 0 ? { warnings: configWarnings } : {}),
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
      countrySets: countrySetResult?.source === "archive" ? countrySetResult.sets : 0,
      countrySetMembers: countrySetResult?.source === "archive" ? countrySetResult.members : 0,
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
        // Older archives predate the column (they restore as "total"); the
        // normaliser also keeps a hand-edited value off the CHECK constraints.
        aggregation: normaliseAggregation(p.level, p.aggregation),
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

/**
 * Country Sets (custom groupings of Region Data countries) as carried by a
 * backup archive. `null` means the archive predates the files.
 *
 * Deliberately kept OUT of {@link ReferenceArchive} and its `present` flag:
 * that flag decides whether the Programs/Offerings tables are wiped and
 * rebuilt, and an archive written between the two features carries
 * programs.json but no country-set files. Folding these in would either make
 * such an archive wipe the live sets, or make a country-sets-only archive
 * wipe programs — each a silent loss.
 */
export interface CountrySetArchive {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sets: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  members: any[];
}

/** A live membership row, snapshotted before a full restore's region wipe. */
export type CountrySetMemberSnapshot = { countrySetId: number; country: string };

/** Outcome of {@link restoreCountrySets}. */
export interface CountrySetRestoreResult {
  /** "archive" = replaced from the archive; "preserved" = live sets kept. */
  source: "archive" | "preserved";
  /** Sets in place after the restore. */
  sets: number;
  /** Memberships written back. */
  members: number;
  /**
   * Memberships dropped because their country (or set) does not exist after
   * the restore. Reported, never silent. Excludes the memberships of sets
   * counted in `droppedSets`, which that warning already covers.
   */
  droppedMembers: number;
  /**
   * Archived sets dropped because their company could not be resolved on this
   * install (always 0 on the preserve branch). Reported, never silent — and
   * never re-homed to some other company, since a set on the wrong partner
   * silently gives that partner wrong compliance results.
   */
  droppedSets: number;
}

/**
 * Decides which local company an archived Country Set belongs to. Built per
 * restore from the live companies read inside the transaction, so both
 * restore paths answer the question the same way. See
 * {@link countrySetCompanyResolver} for the rules.
 */
export interface CountrySetCompanyResolver {
  /**
   * The local company ids an archived set lands in: one id when it resolves,
   * every live company for a legacy (pre-per-company) row, and `[]` when it
   * cannot be resolved and must be dropped.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve(set: any): number[];
}

/**
 * The warnings a Country Set restore produces, shared by both restore paths so
 * the wording cannot drift between them.
 */
export function countrySetWarnings(result: CountrySetRestoreResult | null): string[] {
  const out: string[] = [];
  if (!result) return out;
  if (result.droppedSets > 0) {
    out.push(
      `${result.droppedSets} Country Set(s) belonged to a company that does not exist on this system and were not restored. Create the company and restore again, or recreate the set on the Country Sets page.`
    );
  }
  if (result.droppedMembers > 0) {
    out.push(
      `${result.droppedMembers} Country Set membership(s) named a country or set that is not in the restored data and were removed. Review the Country Sets page.`
    );
  }
  return out;
}

/**
 * Build the company resolver for {@link restoreCountrySets}.
 *
 *  - **Legacy row** — neither `companyId` nor `companyName` (written before
 *    sets were per-company, when every company could report against every
 *    set): COPIED into every live company, mirroring the
 *    `company_scoped_country_sets` migration, so no company's view changes.
 *  - **Full restore** (`companyIdMap` given): the archived `companyId` goes
 *    through the restore's archived-id → local-id map, which is built from
 *    companies.json by name, so it is the authoritative answer. Failing that,
 *    `companyName` → the live company of exactly that name.
 *  - **Config restore** (no map): `companyName` → the live company of exactly
 *    that name. A config archive carries no companies.json, so its `companyId`
 *    indexes another install's table and could name a different partner here.
 *    It is used only when the row carries NO `companyName` at all (an archive
 *    from a build that wrote ids alone) and the id exists locally — a carried
 *    name that does not match is a definite "that company is not here", and
 *    falling through to the id would be exactly the wrong-partner placement
 *    the drop rule exists to prevent.
 *  - Anything else resolves to `[]` and the set is dropped. There is
 *    deliberately no oldest-company fallback (contrast offerings/students).
 */
export function countrySetCompanyResolver(
  liveCompanies: { id: number; name: string }[],
  companyIdMap?: Map<number, number>
): CountrySetCompanyResolver {
  const allIds = liveCompanies.map((c) => c.id);
  const liveIds = new Set(allIds);
  const idByName = new Map(liveCompanies.map((c) => [c.name, c.id] as const));
  return {
    resolve(set) {
      const rawId = set?.companyId;
      const rawName = set?.companyName;
      const hasId = rawId !== undefined && rawId !== null;
      const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
      if (!hasId && rawName == null) return [...allIds];

      if (companyIdMap && Number.isInteger(rawId)) {
        const mapped = companyIdMap.get(rawId as number);
        if (mapped !== undefined) return [mapped];
      }
      if (name !== null) {
        // Exact first; the trimmed form only rescues stray whitespace.
        const byName = idByName.get(rawName as string) ?? idByName.get(name);
        return byName !== undefined ? [byName] : [];
      }
      if (!companyIdMap && rawName == null && Number.isInteger(rawId) && liveIds.has(rawId as number)) {
        return [rawId as number];
      }
      return [];
    },
  };
}

/**
 * Read `country_sets.json` / `country_set_members.json`. Presence keys on the
 * sets file; a members file on its own means nothing and is ignored.
 */
export async function readCountrySetArchive(zip: JSZip): Promise<CountrySetArchive | null> {
  const setsFile = zip.file("country_sets.json");
  if (!setsFile) return null;
  const parsedSets = JSON.parse(await setsFile.async("string"));
  const membersFile = zip.file("country_set_members.json");
  const parsedMembers = membersFile ? JSON.parse(await membersFile.async("string")) : [];
  return {
    sets: Array.isArray(parsedSets) ? parsedSets : [],
    members: Array.isArray(parsedMembers) ? parsedMembers : [],
  };
}

/** Postgres `integer` ceiling — the type of every serial id column here. */
const MAX_PG_INT = 2147483647;

/**
 * A timestamp from a (possibly hand-edited) archive. `new Date(garbage)` does
 * not throw — it yields an Invalid Date, which Prisma then rejects and aborts
 * the restore — so an absent or unparseable value falls back to now.
 */
function archiveDate(v: unknown): Date {
  if (typeof v !== "string" && typeof v !== "number") return new Date();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Rebuild Country Sets inside a restore transaction. MUST run after Region
 * Data is in place: every membership FKs to `region_data.country`.
 *
 *  - `archive` given: replace the sets wholesale. Each archived set is placed
 *    in the company (or, for a legacy row, companies) `resolver` names and is
 *    inserted with a FRESH id — sets are tenant data now, and one archived set
 *    may become several rows, so archived ids cannot be kept. They are used
 *    only to map the archive's members onto the new rows, which is why no
 *    sequence reset is needed any more. Sets whose company does not resolve
 *    are dropped and counted. Members are filtered to countries that exist now
 *    and to sets actually inserted.
 *  - `archive` null (an older archive): the sets themselves are untouched.
 *    A full restore's `regionData.deleteMany` has already cascaded every
 *    membership away, so `liveSnapshot` — read before that delete — is
 *    re-inserted, filtered to the countries the restore put back and to sets
 *    that still exist (a full restore upserts companies and never deletes
 *    them, so the live sets and their ids survive it). The config restore
 *    never deletes region data and passes an empty snapshot.
 */
export async function restoreCountrySets(
  tx: PrismaTransactionClient,
  archive: CountrySetArchive | null,
  liveSnapshot: CountrySetMemberSnapshot[],
  resolver: CountrySetCompanyResolver
): Promise<CountrySetRestoreResult> {
  const countryRows = await tx.regionData.findMany({ select: { country: true } });
  const countries = new Set(countryRows.map((r) => r.country));

  if (!archive) {
    const liveSets = await tx.countrySet.findMany({ select: { id: true } });
    const liveSetIds = new Set(liveSets.map((s) => s.id));
    const rows = liveSnapshot
      .filter((m) => countries.has(m.country) && liveSetIds.has(m.countrySetId))
      .map((m) => ({ countrySetId: m.countrySetId, country: m.country }));
    // `count` is what was actually written: skipDuplicates can skip rows.
    const written =
      rows.length > 0
        ? (await tx.countrySetMember.createMany({ data: rows, skipDuplicates: true })).count
        : 0;
    return {
      source: "preserved",
      sets: liveSets.length,
      members: written,
      droppedMembers: liveSnapshot.length - rows.length,
      droppedSets: 0,
    };
  }

  await tx.countrySetMember.deleteMany({});
  await tx.countrySet.deleteMany({});

  // Tolerate a hand-edited archive. A duplicate archived id would make member
  // mapping ambiguous, and two sets resolving to the same (company, name)
  // would abort the whole restore on the unique index. First occurrence wins.
  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();
  // Archived ids dropped for an unresolved company. Their memberships are
  // covered by the droppedSets warning rather than counted a second time.
  const unresolvedIds = new Set<number>();
  let droppedSets = 0;
  const keyOf = (companyId: number, name: string) => `${companyId}\u0000${name}`;
  // (company, name) of each row to insert → the archived id it came from. The
  // insert returns rows keyed by that unique pair, which is how members are
  // remapped without relying on RETURNING preserving input order.
  const archivedIdByKey = new Map<string, number>();
  const setRows: {
    companyId: number;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  for (const s of archive.sets) {
    const id = s?.id;
    const name = typeof s?.name === "string" ? s.name.trim() : "";
    // Ids are only used to map members now, but a set whose id is not a
    // positive Postgres `integer` cannot have members pointing at it reliably,
    // so it is skipped exactly as before.
    if (!Number.isInteger(id) || id <= 0 || id > MAX_PG_INT || !name) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const companyIds = resolver.resolve(s);
    if (companyIds.length === 0) {
      droppedSets++;
      unresolvedIds.add(id);
      continue;
    }
    for (const companyId of companyIds) {
      const key = keyOf(companyId, name);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      archivedIdByKey.set(key, id);
      setRows.push({
        companyId,
        name,
        description: typeof s.description === "string" ? s.description : null,
        createdAt: archiveDate(s.createdAt),
        updatedAt: archiveDate(s.updatedAt),
      });
    }
  }
  // Fresh ids from the sequence — so, unlike the explicit-id insert this
  // replaced, there is no sequence to move past them afterwards.
  const inserted =
    setRows.length > 0
      ? await tx.countrySet.createManyAndReturn({
          data: setRows,
          select: { id: true, companyId: true, name: true },
        })
      : [];
  // Archived id → the new ids it became: one, or one per company for a legacy
  // row copied into every company.
  const newIdsByArchivedId = new Map<number, number[]>();
  for (const row of inserted) {
    const archivedId = archivedIdByKey.get(keyOf(row.companyId, row.name));
    if (archivedId === undefined) continue;
    const ids = newIdsByArchivedId.get(archivedId) ?? [];
    ids.push(row.id);
    newIdsByArchivedId.set(archivedId, ids);
  }

  const memberRows: { countrySetId: number; country: string }[] = [];
  let droppedMembers = 0;
  for (const m of archive.members) {
    const setId = m?.countrySetId;
    const newIds = Number.isInteger(setId) ? newIdsByArchivedId.get(setId) : undefined;
    if (!newIds || typeof m?.country !== "string" || !countries.has(m.country)) {
      if (!(Number.isInteger(setId) && unresolvedIds.has(setId))) droppedMembers++;
      continue;
    }
    for (const countrySetId of newIds) memberRows.push({ countrySetId, country: m.country });
  }
  const membersWritten =
    memberRows.length > 0
      ? (await tx.countrySetMember.createMany({ data: memberRows, skipDuplicates: true })).count
      : 0;

  return {
    source: "archive",
    sets: inserted.length,
    members: membersWritten,
    droppedMembers,
    droppedSets,
  };
}
