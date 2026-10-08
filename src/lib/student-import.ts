/**
 * The write phase of the student import (`POST /api/import`), batched.
 *
 * The handler used to run ~4–6 sequential queries per row (company, country,
 * student, training, duplicate check, insert). Against a database on another
 * host that is one network round trip each, so a 50,000-row request was
 * ~250k round trips. This module keeps the per-row RULES byte-for-byte — same
 * order of checks, same messages, same counters — and changes only where the
 * answers come from and when the writes happen:
 *
 *   1. `resolveRowPreludes` — the steps the original ran OUTSIDE its per-row
 *      `try` (missing fields, date parse, company resolution, company scope)
 *      are pure given the company table, so they are decided up front for every
 *      row. Existing companies come from one chunked `findMany`; a SuperAdmin's
 *      unknown companies are created in bulk with `createManyAndReturn`.
 *   2. `prefetchImportState` — RegionData, Students, TrainingData and existing
 *      completions for everything the file references, in chunked `in` queries.
 *   3. `processRow` — the original `try` body, verbatim in order, reading and
 *      writing through an {@link ImportEnv}. The fast env (`DeferredEnv`)
 *      answers from the prefetched maps plus a per-chunk overlay and queues the
 *      inserts; the slow env (`ImmediateEnv`) is the original's own queries, one
 *      at a time.
 *   4. Rows are taken {@link ROW_CHUNK} at a time. Each chunk is simulated with
 *      the fast env and flushed in ONE array-form `$transaction` of four
 *      `createMany`s. If that flush fails it rolls back cleanly and the same
 *      chunk is re-run with the slow env, which reproduces the original
 *      row-by-row behaviour — including which rows fail and with which message —
 *      before the next chunk goes back to the fast path.
 *
 * Why a transaction per chunk is safe when a transaction per import is not:
 * the array form has no interactive callback (so Prisma's 5s interactive
 * timeout does not apply) and holds at most four statements of
 * ≤ ROW_CHUNK rows each. Across chunks the import stays non-transactional,
 * exactly like the original: a crash leaves the chunks before it written.
 *
 * The one per-row failure the fast path has to PREDICT rather than discover is
 * the `students_country_fkey` violation of a new student whose country is
 * blank (the import never creates a RegionData row for ""). A file with no
 * Country column hits it on every row, and discovering it by failing each
 * chunk would push the whole file onto the slow path.
 */
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { computeExpiryDate } from "@/lib/utils";
import { parseDateWith, type DateFormat } from "@/lib/date-format";
import { ensureDefaultProductTypeId } from "@/lib/product-types";

/** Values per `in (…)` list. */
export const IN_LIST_CHUNK = 5_000;
/** Rows simulated and flushed together; also the slow path's blast radius. */
export const ROW_CHUNK = 2_000;

export interface ImportRow {
  fullName: string;
  email: string;
  theatre: string;
  country: string;
  title: string;
  completedDate: string;
  company: string;
}

export interface ImportSummary {
  studentsCreated: number;
  studentsUpdated: number;
  trainingsCreated: number;
  trainingsSkipped: number;
  trainingsAutoCreated: number;
  companiesCreated: number;
  companyConflicts: number;
  dateFormatUsed: DateFormat | null;
  errors: string[];
}

type Company = { id: number; name: string };
type RegionEntry = { country: string; region: string; theatre: string | null };
type RecomputePair = { email: string; subItemTrainingTitle: string };

type Prelude =
  | { kind: "error"; message: string }
  | { kind: "ok"; completedDate: Date; company: Company };

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * PostgreSQL text cannot hold U+0000, so such a value can never match a row
 * and makes the whole query fail. The original sent one value per query and
 * lost one row; a bulk `in (…)` list must leave it out instead, and let the
 * write path discover the failure for that row alone.
 */
function storable(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\u0000");
}

function takenKey(email: string, trainingTitle: string, completedDate: Date): string {
  return `${email}\u0000${trainingTitle}\u0000${completedDate.getTime()}`;
}

// ─── 1. The pre-`try` steps, decided for every row ─────────────────────────

/**
 * Replays the original's validation + company resolution in row order.
 *
 * The company cache is keyed by LOWER-CASED name while the lookup is EXACT
 * (company names are unique with exact case), and a non-SuperAdmin's miss is
 * not cached, so each spelling of a missing company is looked up afresh. Both
 * are reproduced here: the cache is replayed in order over a map of every
 * exact spelling the file uses.
 */
export async function resolveRowPreludes(opts: {
  rows: ImportRow[];
  effectiveFormat: DateFormat;
  defaultCompany: Company | null;
  allowed: Set<number> | null;
  callerIsSuperAdmin: boolean;
  summary: ImportSummary;
}): Promise<Prelude[]> {
  const { rows, effectiveFormat, defaultCompany, allowed, callerIsSuperAdmin, summary } = opts;

  type Draft =
    | { kind: "error"; message: string }
    | { kind: "company"; completedDate: Date; name: string; rowNum: number }
    | { kind: "default"; completedDate: Date; rowNum: number };

  const drafts: Draft[] = rows.map((row, i) => {
    const rowNum = i + 2;
    if (!row.email) return { kind: "error", message: `Row ${rowNum}: Missing email address` };
    if (!row.fullName) {
      return { kind: "error", message: `Row ${rowNum}: Missing full name for ${row.email}` };
    }
    if (!row.title) {
      return { kind: "error", message: `Row ${rowNum}: Missing training title for ${row.email}` };
    }
    if (!row.completedDate) {
      return { kind: "error", message: `Row ${rowNum}: Missing completed date for ${row.email}` };
    }
    const completedDate = parseDateWith(row.completedDate, effectiveFormat);
    if (!completedDate) {
      return {
        kind: "error",
        message: `Row ${rowNum}: Invalid date "${row.completedDate}" — expected ${effectiveFormat} for ${row.email}`,
      };
    }
    const name = row.company.trim();
    if (name) return { kind: "company", completedDate, name, rowNum };
    return { kind: "default", completedDate, rowNum };
  });

  // Every exact spelling the file names, fetched in one pass.
  const spellings = [
    ...new Set(drafts.flatMap((d) => (d.kind === "company" && storable(d.name) ? [d.name] : []))),
  ];
  const byExactName = new Map<string, Company>();
  for (const names of chunk(spellings, IN_LIST_CHUNK)) {
    const found = await prisma.company.findMany({
      where: { name: { in: names } },
      select: { id: true, name: true },
    });
    for (const c of found) byExactName.set(c.name, c);
  }

  const cache = new Map<string, Company>();
  if (defaultCompany) cache.set(defaultCompany.name.toLowerCase(), defaultCompany);
  // Companies a SuperAdmin's file introduces, in first-seen order; their ids
  // are filled in after the bulk create below.
  const toCreate: Company[] = [];

  const resolved: (Prelude | { kind: "pending"; completedDate: Date; company: Company; rowNum: number })[] =
    drafts.map((d) => {
      if (d.kind === "error") return d;
      if (d.kind === "default") {
        if (!defaultCompany) {
          return {
            kind: "error",
            message: `Row ${d.rowNum}: No company specified and no default company selected`,
          };
        }
        return { kind: "pending", completedDate: d.completedDate, company: defaultCompany, rowNum: d.rowNum };
      }
      const cached = cache.get(d.name.toLowerCase());
      if (cached) return { kind: "pending", completedDate: d.completedDate, company: cached, rowNum: d.rowNum };
      // The original's lookup threw here, outside its per-row handling.
      if (!storable(d.name)) throw new Error("Company name is not storable");
      const found = byExactName.get(d.name);
      if (found) {
        cache.set(found.name.toLowerCase(), found);
        return { kind: "pending", completedDate: d.completedDate, company: found, rowNum: d.rowNum };
      }
      if (callerIsSuperAdmin) {
        const created: Company = { id: 0, name: d.name };
        toCreate.push(created);
        cache.set(created.name.toLowerCase(), created);
        summary.companiesCreated++;
        return { kind: "pending", completedDate: d.completedDate, company: created, rowNum: d.rowNum };
      }
      return {
        kind: "error",
        message: `Row ${d.rowNum}: Company "${d.name}" does not exist. Ask a SuperAdmin to create it.`,
      };
    });

  // Like the original's `company.create`, this sits outside any per-row
  // handling: a failure here is a 500 for the whole request.
  for (const batch of chunk(toCreate, IN_LIST_CHUNK)) {
    const created = await prisma.company.createManyAndReturn({
      data: batch.map((c) => ({ name: c.name })),
      select: { id: true, name: true },
    });
    const idByName = new Map(created.map((c) => [c.name, c.id]));
    for (const c of batch) {
      const id = idByName.get(c.name);
      if (id === undefined) throw new Error(`Company "${c.name}" was not created`);
      c.id = id;
    }
  }

  return resolved.map((r) => {
    if (r.kind !== "pending") return r;
    if (allowed !== null && !allowed.has(r.company.id)) {
      return {
        kind: "error",
        message: `Row ${r.rowNum}: Out of scope — you do not have access to "${r.company.name}".`,
      };
    }
    return { kind: "ok", completedDate: r.completedDate, company: r.company };
  });
}

// ─── 2. What already exists ────────────────────────────────────────────────

/** Committed database state as far as this import is concerned. */
export interface ImportState {
  regions: Map<string, RegionEntry>;
  /** email -> companyId */
  students: Map<string, number>;
  trainings: Set<string>;
  /** `takenKey(email, title, completedDate)` for every existing completion. */
  taken: Set<string>;
}

export async function prefetchImportState(rows: ImportRow[], preludes: Prelude[]): Promise<ImportState> {
  const countries = new Set<string>([""]); // "" decides the blank-country FK prediction
  const emails = new Set<string>();
  const titles = new Set<string>();
  rows.forEach((row, i) => {
    if (preludes[i].kind !== "ok") return;
    if (storable(row.country)) countries.add(row.country);
    if (storable(row.email)) emails.add(row.email);
    if (storable(row.title)) titles.add(row.title);
  });

  const state: ImportState = {
    regions: new Map(),
    students: new Map(),
    trainings: new Set(),
    taken: new Set(),
  };

  for (const batch of chunk([...countries], IN_LIST_CHUNK)) {
    const found = await prisma.regionData.findMany({
      where: { country: { in: batch } },
      select: { country: true, region: true, theatre: true },
    });
    for (const r of found) state.regions.set(r.country, r);
  }
  const emailList = [...emails];
  for (const batch of chunk(emailList, IN_LIST_CHUNK)) {
    const found = await prisma.student.findMany({
      where: { email: { in: batch } },
      select: { email: true, companyId: true },
    });
    for (const s of found) state.students.set(s.email, s.companyId);
  }
  const titleList = [...titles];
  for (const batch of chunk(titleList, IN_LIST_CHUNK)) {
    const found = await prisma.trainingData.findMany({
      where: { trainingTitle: { in: batch } },
      select: { trainingTitle: true },
    });
    for (const t of found) state.trainings.add(t.trainingTitle);
  }
  // Completions of the file's learners for the file's titles — a superset of
  // the (email, title, date) triples the duplicate check asks about, bounded by
  // what the file names rather than by everything those learners ever took.
  for (const emailBatch of chunk(emailList, IN_LIST_CHUNK)) {
    for (const titleBatch of chunk(titleList, IN_LIST_CHUNK)) {
      const found = await prisma.trainingTaken.findMany({
        where: { email: { in: emailBatch }, trainingTitle: { in: titleBatch } },
        select: { email: true, trainingTitle: true, completedDate: true },
      });
      for (const t of found) state.taken.add(takenKey(t.email, t.trainingTitle, t.completedDate));
    }
  }
  return state;
}

// ─── 3. One row, against an env ────────────────────────────────────────────

interface ImportEnv {
  getRegion(country: string): Promise<RegionEntry | null>;
  createRegion(data: RegionEntry): Promise<RegionEntry>;
  getStudentCompanyId(email: string): Promise<number | null>;
  createStudent(data: Prisma.StudentCreateManyInput): Promise<void>;
  trainingExists(title: string): Promise<boolean>;
  createTraining(title: string): Promise<void>;
  takenExists(email: string, title: string, completedDate: Date): Promise<boolean>;
  createTaken(data: Prisma.TrainingTakenCreateManyInput): Promise<void>;
}

/** What a run of rows contributes to the response, committed in row order. */
interface RowOutput {
  errors: string[];
  studentsCreated: number;
  studentsUpdated: number;
  trainingsCreated: number;
  trainingsSkipped: number;
  trainingsAutoCreated: number;
  companyConflicts: number;
  touchedCompanies: Set<number>;
  recomputePairs: RecomputePair[];
}

function emptyOutput(): RowOutput {
  return {
    errors: [],
    studentsCreated: 0,
    studentsUpdated: 0,
    trainingsCreated: 0,
    trainingsSkipped: 0,
    trainingsAutoCreated: 0,
    companyConflicts: 0,
    touchedCompanies: new Set(),
    recomputePairs: [],
  };
}

/**
 * The original handler's per-row `try` body. Keep it in step with nothing
 * else: the order of steps decides which warnings a failing row still emits
 * and which of its writes survive, and both are part of the response.
 */
async function processRow(
  row: ImportRow,
  rowNum: number,
  company: Company,
  completedDate: Date,
  allowed: Set<number> | null,
  env: ImportEnv,
  out: RowOutput,
): Promise<void> {
  try {
    // ─── Resolve theatre via RegionData (source of truth) ──────────────────
    // - Country known with theatre set: warn if the row's theatre differs,
    //   then use the RegionData theatre.
    // - Country known with no theatre: keep row's theatre, warn so the
    //   SuperAdmin populates RegionData.
    // - Country unknown: auto-create RegionData with NO region (an empty
    //   string, the first-class "not defined yet" state), keep row's theatre,
    //   warn.
    const csvTheatre = (row.theatre || "").trim();
    let resolvedTheatre = csvTheatre;
    if (row.country) {
      // The original handed a non-string straight to Prisma, which threw here.
      if (typeof row.country !== "string") throw new Error("Invalid country value");
      let rd = await env.getRegion(row.country);
      if (!rd) {
        rd = await env.createRegion({ country: row.country, region: "", theatre: csvTheatre || null });
        out.errors.push(
          `Row ${rowNum}: Country "${row.country}" was not in Region Data; created with no region${
            csvTheatre ? ` and theatre "${csvTheatre}"` : " and no theatre"
          }. Ask a SuperAdmin to verify.`
        );
      }
      if (rd.theatre) {
        // Deliberately on every row, not once per country.
        if (csvTheatre && csvTheatre !== rd.theatre) {
          out.errors.push(
            `Row ${rowNum}: Theatre "${csvTheatre}" for country "${row.country}" overridden to "${rd.theatre}" (per Region Data).`
          );
        }
        resolvedTheatre = rd.theatre;
      } else if (csvTheatre) {
        out.errors.push(
          `Row ${rowNum}: Country "${row.country}" has no theatre in Region Data; using imported theatre "${csvTheatre}".`
        );
      }
    }

    const existingCompanyId = await env.getStudentCompanyId(row.email);
    let studentCompanyId = company.id;

    if (existingCompanyId !== null) {
      if (allowed !== null && !allowed.has(existingCompanyId)) {
        out.errors.push(
          `Row ${rowNum}: Out of scope — student ${row.email} belongs to a company you cannot access.`
        );
        return;
      }
      if (existingCompanyId !== company.id) {
        out.companyConflicts++;
        out.errors.push(
          `Row ${rowNum}: ${row.email} is already assigned to a different company; the row's company "${company.name}" was ignored. Reassign manually if required.`
        );
      }
      studentCompanyId = existingCompanyId;
      out.studentsUpdated++;
    } else {
      await env.createStudent({
        email: row.email,
        fullName: row.fullName,
        theatre: resolvedTheatre,
        country: row.country,
        companyId: studentCompanyId,
      });
      out.studentsCreated++;
    }

    out.touchedCompanies.add(studentCompanyId);

    if (typeof row.title !== "string") throw new Error("Invalid training title value");
    if (!(await env.trainingExists(row.title))) {
      // trainingType/productTypeId/function are PLACEHOLDERS on an
      // `isIncomplete` row — see the env implementations.
      await env.createTraining(row.title);
      out.trainingsAutoCreated++;
    }

    const expiryDate = computeExpiryDate(completedDate);
    if (await env.takenExists(row.email, row.title, completedDate)) {
      out.trainingsSkipped++;
      return;
    }

    await env.createTaken({
      email: row.email,
      trainingTitle: row.title,
      completedDate,
      expiryDate,
    });
    out.trainingsCreated++;
    out.recomputePairs.push({ email: row.email, subItemTrainingTitle: row.title });
  } catch (error) {
    console.error(`Import row ${rowNum} error:`, error);
    const safeMessage = error instanceof Error && error.message.includes("Unique constraint")
      ? "Duplicate entry"
      : "Failed to process";
    out.errors.push(`Row ${rowNum}: ${safeMessage}`);
  }
}

function placeholderTraining(title: string, productTypeId: number): Prisma.TrainingDataCreateManyInput {
  // trainingType/productTypeId/function are PLACEHOLDERS, not guesses to be
  // trusted: the columns are NOT NULL so a value must be written, but nobody
  // has chosen one. `isIncomplete: true` is what marks them as unsupplied —
  // /admin/training-data renders those three as "Not set" in its amber table
  // and refuses to clear the flag until an admin picks real values. Don't
  // surface these anywhere as if they were curated.
  return {
    trainingTitle: title,
    fullTitle: title,
    trainingType: "Certification",
    productTypeId,
    function: "Sales",
    isIncomplete: true,
  };
}

/** The default product type, resolved lazily on the first auto-created training, as before. */
class ProductTypeResolver {
  private id: number | undefined;
  async get(): Promise<number> {
    if (this.id === undefined) this.id = await ensureDefaultProductTypeId();
    return this.id;
  }
}

/**
 * Fast path: answers from committed state plus this chunk's own pending
 * writes, and queues the writes for one flush.
 */
class DeferredEnv implements ImportEnv {
  readonly regions = new Map<string, RegionEntry>();
  readonly students = new Map<string, number>();
  readonly trainings = new Set<string>();
  readonly taken = new Set<string>();
  readonly regionRows: RegionEntry[] = [];
  readonly studentRows: Prisma.StudentCreateManyInput[] = [];
  readonly trainingRows: Prisma.TrainingDataCreateManyInput[] = [];
  readonly takenRows: Prisma.TrainingTakenCreateManyInput[] = [];

  constructor(private readonly base: ImportState, private readonly productType: ProductTypeResolver) {}

  async getRegion(country: string) {
    return this.regions.get(country) ?? this.base.regions.get(country) ?? null;
  }
  async createRegion(data: RegionEntry) {
    this.regionRows.push(data);
    this.regions.set(data.country, data);
    return data;
  }
  async getStudentCompanyId(email: string) {
    return this.students.get(email) ?? this.base.students.get(email) ?? null;
  }
  async createStudent(data: Prisma.StudentCreateManyInput) {
    // The import never creates a RegionData row for a blank country, so a new
    // student with one fails `students_country_fkey` — predict it here rather
    // than discover it by failing the whole chunk. Message deliberately does
    // not contain "Unique constraint", so it classifies as "Failed to process"
    // exactly like Prisma's own foreign-key error.
    if (!this.regions.has(data.country) && !this.base.regions.has(data.country)) {
      throw new Error("Foreign key constraint violated: students_country_fkey (predicted)");
    }
    this.studentRows.push(data);
    this.students.set(data.email, data.companyId);
  }
  async trainingExists(title: string) {
    return this.trainings.has(title) || this.base.trainings.has(title);
  }
  async createTraining(title: string) {
    this.trainingRows.push(placeholderTraining(title, await this.productType.get()));
    this.trainings.add(title);
  }
  async takenExists(email: string, title: string, completedDate: Date) {
    const key = takenKey(email, title, completedDate);
    return this.taken.has(key) || this.base.taken.has(key);
  }
  async createTaken(data: Prisma.TrainingTakenCreateManyInput) {
    this.takenRows.push(data);
    this.taken.add(takenKey(data.email, data.trainingTitle, data.completedDate as Date));
  }

  /** One short transaction; FK order: regions, students, trainings, completions. */
  async flush(): Promise<void> {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    if (this.regionRows.length) ops.push(prisma.regionData.createMany({ data: this.regionRows }));
    // No skipDuplicates: a student created concurrently must surface as a
    // failed flush (and so a slow-path re-run), not be silently counted.
    if (this.studentRows.length) ops.push(prisma.student.createMany({ data: this.studentRows }));
    // skipDuplicates matches the original's `upsert … update: {}`.
    if (this.trainingRows.length) {
      ops.push(prisma.trainingData.createMany({ data: this.trainingRows, skipDuplicates: true }));
    }
    if (this.takenRows.length) ops.push(prisma.trainingTaken.createMany({ data: this.takenRows }));
    if (ops.length) await prisma.$transaction(ops);
  }

  commitInto(base: ImportState): void {
    for (const [k, v] of this.regions) base.regions.set(k, v);
    for (const [k, v] of this.students) base.students.set(k, v);
    for (const t of this.trainings) base.trainings.add(t);
    for (const k of this.taken) base.taken.add(k);
  }
}

/**
 * Slow path: the original handler's own queries, one at a time, keeping the
 * committed state in step as it goes. Used only to re-run a chunk whose
 * batched flush failed, so that chunk behaves exactly as it always did.
 */
class ImmediateEnv implements ImportEnv {
  constructor(private readonly base: ImportState, private readonly productType: ProductTypeResolver) {}

  async getRegion(country: string) {
    const hit = this.base.regions.get(country);
    if (hit) return hit;
    const found = await prisma.regionData.findUnique({ where: { country } });
    if (!found) return null;
    const rd = { country: found.country, region: found.region, theatre: found.theatre };
    this.base.regions.set(country, rd);
    return rd;
  }
  async createRegion(data: RegionEntry) {
    const created = await prisma.regionData.create({ data });
    const rd = { country: created.country, region: created.region, theatre: created.theatre };
    this.base.regions.set(rd.country, rd);
    return rd;
  }
  async getStudentCompanyId(email: string) {
    const hit = this.base.students.get(email);
    if (hit !== undefined) return hit;
    const found = await prisma.student.findUnique({ where: { email } });
    if (!found) return null;
    this.base.students.set(email, found.companyId);
    return found.companyId;
  }
  async createStudent(data: Prisma.StudentCreateManyInput) {
    await prisma.student.create({ data });
    this.base.students.set(data.email, data.companyId);
  }
  async trainingExists(title: string) {
    if (this.base.trainings.has(title)) return true;
    const found = await prisma.trainingData.findUnique({ where: { trainingTitle: title } });
    if (found) this.base.trainings.add(title);
    return found !== null;
  }
  async createTraining(title: string) {
    const data = placeholderTraining(title, await this.productType.get());
    await prisma.trainingData.upsert({
      where: { trainingTitle: title },
      update: {},
      create: data as Prisma.TrainingDataUncheckedCreateInput,
    });
    this.base.trainings.add(title);
  }
  async takenExists(email: string, title: string, completedDate: Date) {
    const key = takenKey(email, title, completedDate);
    if (this.base.taken.has(key)) return true;
    const found = await prisma.trainingTaken.findFirst({
      where: { email, trainingTitle: title, completedDate },
    });
    if (found) this.base.taken.add(key);
    return found !== null;
  }
  async createTaken(data: Prisma.TrainingTakenCreateManyInput) {
    await prisma.trainingTaken.create({ data });
    this.base.taken.add(takenKey(data.email, data.trainingTitle, data.completedDate as Date));
  }
}

// ─── 4. The whole write phase ──────────────────────────────────────────────

export interface StudentImportResult {
  recomputePairs: RecomputePair[];
  touchedCompanies: Set<number>;
  /** Chunks whose batched flush failed and were re-run row by row. */
  slowPathChunks: number;
}

function commitOutput(summary: ImportSummary, result: StudentImportResult, out: RowOutput): void {
  summary.studentsCreated += out.studentsCreated;
  summary.studentsUpdated += out.studentsUpdated;
  summary.trainingsCreated += out.trainingsCreated;
  summary.trainingsSkipped += out.trainingsSkipped;
  summary.trainingsAutoCreated += out.trainingsAutoCreated;
  summary.companyConflicts += out.companyConflicts;
  for (const e of out.errors) summary.errors.push(e);
  for (const c of out.touchedCompanies) result.touchedCompanies.add(c);
  for (const p of out.recomputePairs) result.recomputePairs.push(p);
}

export async function runStudentImport(opts: {
  rows: ImportRow[];
  effectiveFormat: DateFormat;
  defaultCompany: Company | null;
  allowedCompanyIds: number[] | null;
  callerIsSuperAdmin: boolean;
  summary: ImportSummary;
}): Promise<StudentImportResult> {
  const { rows, summary } = opts;
  const allowed = opts.allowedCompanyIds === null ? null : new Set(opts.allowedCompanyIds);

  const preludes = await resolveRowPreludes({
    rows,
    effectiveFormat: opts.effectiveFormat,
    defaultCompany: opts.defaultCompany,
    allowed,
    callerIsSuperAdmin: opts.callerIsSuperAdmin,
    summary,
  });
  const state = await prefetchImportState(rows, preludes);
  const productType = new ProductTypeResolver();
  const result: StudentImportResult = { recomputePairs: [], touchedCompanies: new Set(), slowPathChunks: 0 };

  const runChunk = async (start: number, end: number, env: ImportEnv): Promise<RowOutput> => {
    const out = emptyOutput();
    for (let i = start; i < end; i++) {
      const p = preludes[i];
      if (p.kind === "error") {
        out.errors.push(p.message);
        continue;
      }
      await processRow(rows[i], i + 2, p.company, p.completedDate, allowed, env, out);
    }
    return out;
  };

  for (let start = 0; start < rows.length; start += ROW_CHUNK) {
    const end = Math.min(start + ROW_CHUNK, rows.length);
    const deferred = new DeferredEnv(state, productType);
    const out = await runChunk(start, end, deferred);
    try {
      await deferred.flush();
      deferred.commitInto(state);
      commitOutput(summary, result, out);
    } catch (error) {
      // Rolled back as a unit, so the database is as it was before this chunk
      // and `state` never saw the overlay. Re-run it the original way.
      console.warn(`Import rows ${start + 2}–${end + 1}: batched write failed, retrying row by row:`, error);
      result.slowPathChunks++;
      commitOutput(summary, result, await runChunk(start, end, new ImmediateEnv(state, productType)));
    }
  }

  return result;
}

/**
 * Global + per-company "last imported" stamps. Same final state as one upsert
 * per key, in two statements per {@link IN_LIST_CHUNK} companies — an import
 * touching thousands of companies otherwise paid one round trip each.
 */
export async function stampImportMetadata(touchedCompanies: Set<number>, importedAt: Date): Promise<void> {
  await prisma.importMetadata.upsert({
    where: { key: "students" },
    update: { timestamp: importedAt },
    create: { key: "students", timestamp: importedAt },
  });
  const keys = [...touchedCompanies].map((cid) => `students:${cid}`);
  for (const batch of chunk(keys, IN_LIST_CHUNK)) {
    await prisma.importMetadata.updateMany({
      where: { key: { in: batch } },
      data: { timestamp: importedAt },
    });
    await prisma.importMetadata.createMany({
      data: batch.map((key) => ({ key, timestamp: importedAt })),
      skipDuplicates: true,
    });
  }
}
