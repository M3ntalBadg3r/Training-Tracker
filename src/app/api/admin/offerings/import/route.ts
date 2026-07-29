import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { canAccessCompany } from "@/lib/company-scope";

interface RawRow {
  offeringName?: string;
  description?: string;
  link?: string;
  specialisationName?: string;
  trainingType?: string;
  trainingFullTitle?: string;
  quantityRequired?: string | number;
  alternatives?: string;
}

const NULL_MARKERS = new Set(["—", "-", "–", "n/a", "none", ""]);

function isNullMarker(val: string): boolean {
  return NULL_MARKERS.has(val.trim().toLowerCase());
}

const TRAINING_TYPE_MAP: Record<string, string> = {
  certification: "Certification",
  cert: "Certification",
  accreditation: "Accreditation",
  accred: "Accreditation",
  instructorledtraining: "InstructorLedTraining",
  "instructor-led training": "InstructorLedTraining",
  instructorled: "InstructorLedTraining",
  ilt: "InstructorLedTraining",
  "instructor led training": "InstructorLedTraining",
  olx: "OLX",
};

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveTrainingType(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  const normalised = normalise(raw.trim());
  if (TRAINING_TYPE_MAP[key]) return TRAINING_TYPE_MAP[key];
  if (TRAINING_TYPE_MAP[normalised]) return TRAINING_TYPE_MAP[normalised];
  if (["Certification", "Accreditation", "InstructorLedTraining", "OLX"].includes(raw.trim())) return raw.trim();
  return null;
}

/** A validated, resolved row. `requirement` is null for a specialisation-only
 *  row (records the offering ↔ specialisation link without a requirement). */
interface ResolvedRow {
  offeringName: string;
  description: string | null;
  link: string | null;
  specialisationName: string | null;
  requirement: {
    trainingType: "Certification" | "Accreditation" | "InstructorLedTraining" | "OLX";
    trainingTitle: string;
    quantityRequired: number;
    altData: { trainingType: string; trainingTitle: string }[];
  } | null;
}

type ValidateResult = { ok: true; value: ResolvedRow } | { ok: false; message: string };

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const body = await request.json();
  const rows: RawRow[] = body.rows ?? [];

  // Names are unique per company, so an import targets a single company.
  const companyId = body?.companyId == null ? NaN : Number(body.companyId);
  if (Number.isNaN(companyId)) {
    return NextResponse.json({ error: "A company is required" }, { status: 400 });
  }
  if (!(await canAccessCompany(auth.sub, auth.role, companyId))) {
    return NextResponse.json({ error: "You do not have access to that company" }, { status: 403 });
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows provided" }, { status: 400 });
  }
  if (rows.length > 10_000) {
    return NextResponse.json({ error: "Too many rows in a single import (max 10,000)." }, { status: 413 });
  }

  const allTrainings = await prisma.trainingData.findMany({
    select: { trainingTitle: true, fullTitle: true, trainingType: true },
  });
  const fullTitleMap = new Map<string, { trainingTitle: string; trainingType: string }>();
  for (const t of allTrainings) {
    const key = normalise(t.fullTitle);
    if (!fullTitleMap.has(key)) fullTitleMap.set(key, { trainingTitle: t.trainingTitle, trainingType: t.trainingType });
  }

  function validateRow(raw: RawRow): ValidateResult {
    const offeringName = raw.offeringName?.trim() ?? "";
    if (!offeringName) return { ok: false, message: "Offering Name is required" };

    const description = isNullMarker(raw.description?.trim() ?? "") ? null : (raw.description?.trim() ?? null);
    const link = isNullMarker(raw.link?.trim() ?? "") ? null : (raw.link?.trim() ?? null);
    const specialisationName = isNullMarker(raw.specialisationName?.trim() ?? "")
      ? ""
      : (raw.specialisationName?.trim() ?? "");
    const rawTrainingType = isNullMarker(raw.trainingType?.trim() ?? "") ? "" : (raw.trainingType?.trim() ?? "");
    const rawTrainingFullTitle = isNullMarker(raw.trainingFullTitle?.trim() ?? "")
      ? ""
      : (raw.trainingFullTitle?.trim() ?? "");
    const rawAlternatives = raw.alternatives?.trim() ?? "";

    if (!specialisationName) {
      return { ok: false, message: "Specialisation is required" };
    }

    const hasTraining = rawTrainingFullTitle !== "";

    // Specialisation-only row: records the offering ↔ specialisation selection.
    if (!hasTraining) {
      return { ok: true, value: { offeringName, description, link, specialisationName, requirement: null } };
    }

    if (!rawTrainingType) return { ok: false, message: "Training Type is required when Training is specified" };
    const rt = resolveTrainingType(rawTrainingType);
    if (!rt) {
      return {
        ok: false,
        message: `Unknown Training Type "${rawTrainingType}". Use: Certification, Accreditation, ILT, or OLX`,
      };
    }
    const trainingMatch = fullTitleMap.get(normalise(rawTrainingFullTitle));
    if (!trainingMatch) {
      return { ok: false, message: `Training "${rawTrainingFullTitle}" not found in the training catalog` };
    }

    const rawQty = raw.quantityRequired;
    const quantityRequired = typeof rawQty === "number" ? rawQty : parseInt(String(rawQty ?? ""), 10);
    if (isNaN(quantityRequired) || quantityRequired < 1) {
      return { ok: false, message: "Quantity Required must be a number ≥ 1" };
    }

    const altData: { trainingType: string; trainingTitle: string }[] = [];
    if (rawAlternatives && !isNullMarker(rawAlternatives)) {
      const altNames = rawAlternatives.split("|").map((s) => s.trim()).filter(Boolean);
      for (const altName of altNames) {
        const altMatch = fullTitleMap.get(normalise(altName));
        if (!altMatch) return { ok: false, message: `Alternative training "${altName}" not found in the training catalog` };
        altData.push({ trainingType: altMatch.trainingType, trainingTitle: altMatch.trainingTitle });
      }
    }

    return {
      ok: true,
      value: {
        offeringName,
        description,
        link,
        specialisationName,
        requirement: {
          trainingType: rt as "Certification" | "Accreditation" | "InstructorLedTraining" | "OLX",
          trainingTitle: trainingMatch.trainingTitle,
          quantityRequired,
          altData,
        },
      },
    };
  }

  const errors: { row: number; message: string }[] = [];
  const resolved: ResolvedRow[] = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const result = validateRow(rows[i]);
    if (!result.ok) {
      errors.push({ row: i + 1, message: result.message });
      skipped++;
      continue;
    }
    resolved.push(result.value);
  }

  if (dryRun) {
    return NextResponse.json({ created: resolved.length, skipped, errors });
  }

  // Offerings named in this file are overwritten: their existing requirements +
  // specialisation links are replaced (not merged) so a re-import never dupes.
  const offeringNames = [...new Set(resolved.map((r) => r.offeringName))];

  // First non-null description/link per offering wins (export repeats them).
  const offeringMeta = new Map<string, { description: string | null; link: string | null }>();
  for (const r of resolved) {
    if (!offeringMeta.has(r.offeringName)) {
      offeringMeta.set(r.offeringName, { description: r.description, link: r.link });
    } else {
      const m = offeringMeta.get(r.offeringName)!;
      if (m.description === null && r.description !== null) m.description = r.description;
      if (m.link === null && r.link !== null) m.link = r.link;
    }
  }

  let created = 0;

  await prisma.$transaction(
    async (tx) => {
      // 1. Register offerings (persist as admin cards; apply description/link).
      //    Names are scoped to this company via the (companyId, name) unique.
      const offeringIdByName = new Map<string, number>();
      for (const name of offeringNames) {
        const meta = offeringMeta.get(name) ?? { description: null, link: null };
        const offering = await tx.offering.upsert({
          where: { companyId_name: { companyId, name } },
          create: { companyId, name, description: meta.description, link: meta.link },
          update: { description: meta.description, link: meta.link },
        });
        offeringIdByName.set(name, offering.id);
      }

      // 2. Replace: wipe those offerings' requirements + specialisation links
      //    (alternatives cascade via FK). Keyed on the resolved offering ids so
      //    another company's identically-named offering is never touched.
      const offeringIds = [...offeringIdByName.values()];
      await tx.offeringData.deleteMany({ where: { offeringId: { in: offeringIds } } });
      await tx.offeringSpecialisation.deleteMany({ where: { offeringId: { in: offeringIds } } });

      // 3. Resolve specialisations (create if missing).
      const specIdCache = new Map<string, number>();
      const specNames = [...new Set(resolved.map((r) => r.specialisationName).filter((n): n is string => !!n))];
      for (const name of specNames) {
        let spec = await tx.specialisation.findFirst({ where: { name } });
        if (!spec) spec = await tx.specialisation.create({ data: { name } });
        specIdCache.set(name.toLowerCase(), spec.id);
      }

      // 4. Re-create the offering ↔ specialisation links (dedup per pair).
      const linkSeen = new Set<string>();
      for (const r of resolved) {
        if (!r.specialisationName) continue;
        const offeringId = offeringIdByName.get(r.offeringName);
        const specId = specIdCache.get(r.specialisationName.toLowerCase());
        if (offeringId == null || specId == null) continue;
        const key = `${offeringId}::${specId}`;
        if (linkSeen.has(key)) continue;
        linkSeen.add(key);
        await tx.offeringSpecialisation.create({
          data: { offeringId, specialisationId: specId },
        });
      }

      // 5. Create the requirement rows.
      for (const r of resolved) {
        if (!r.requirement || !r.specialisationName) continue;
        const offeringId = offeringIdByName.get(r.offeringName);
        const specId = specIdCache.get(r.specialisationName.toLowerCase());
        if (offeringId == null || specId == null) continue;
        const req = r.requirement;
        await tx.offeringData.create({
          data: {
            offeringId,
            specialisationId: specId,
            trainingType: req.trainingType,
            trainingTitle: req.trainingTitle,
            quantityRequired: req.quantityRequired,
            alternatives:
              req.altData.length > 0
                ? {
                    create: req.altData.map((a) => ({
                      trainingType: a.trainingType as "Certification" | "Accreditation" | "InstructorLedTraining" | "OLX",
                      trainingTitle: a.trainingTitle,
                    })),
                  }
                : undefined,
          },
        });
        created++;
      }
    },
    { timeout: 120_000, maxWait: 10_000 }
  );

  // Stamp the global + per-company "last imported" timestamps (offerings are
  // company-scoped, so the Offerings page shows the selected company's time).
  const importedAt = new Date();
  await prisma.importMetadata.upsert({
    where: { key: "offerings" },
    update: { timestamp: importedAt },
    create: { key: "offerings", timestamp: importedAt },
  });
  await prisma.importMetadata.upsert({
    where: { key: `offerings:${companyId}` },
    update: { timestamp: importedAt },
    create: { key: `offerings:${companyId}`, timestamp: importedAt },
  });

  return NextResponse.json({ created, skipped, errors });
}
