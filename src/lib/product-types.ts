/**
 * Helpers for the data-driven ProductType table (admin-managed list that
 * replaced the old hardcoded Postgres enum). Training data references a
 * product type by id; these helpers resolve incoming name strings (from forms
 * and imports) to ids, list the available names, and pick a sensible default.
 */

import prisma from "@/lib/prisma";

/** Distinct product type names, alphabetically sorted. */
export async function getProductTypeNames(): Promise<string[]> {
  const rows = await prisma.productType.findMany({
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r: { name: string }) => r.name);
}

/**
 * Resolve a product type name to its id (case-insensitive, trimmed).
 * Returns null when the name is empty or does not match any row.
 */
export async function resolveProductTypeId(name: string | null | undefined): Promise<number | null> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const match = await prisma.productType.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
    select: { id: true },
  });
  return match?.id ?? null;
}

/**
 * The fallback product type id when none is specified — the alphabetically
 * first row. Returns null when the table is empty (callers must then either
 * reject the operation or create a row via {@link ensureDefaultProductTypeId}).
 */
export async function getDefaultProductTypeId(): Promise<number | null> {
  const row = await prisma.productType.findFirst({
    select: { id: true },
    orderBy: { name: "asc" },
  });
  return row?.id ?? null;
}

/**
 * Like {@link getDefaultProductTypeId}, but guarantees a row exists by creating
 * an "Unspecified" product type when the table is empty. Used by flows that
 * must auto-create training data (e.g. student import) and cannot fail.
 */
export async function ensureDefaultProductTypeId(): Promise<number> {
  const existing = await getDefaultProductTypeId();
  if (existing !== null) return existing;
  const created = await prisma.productType.create({
    data: { name: "Unspecified" },
    select: { id: true },
  });
  return created.id;
}

/**
 * Normalise backup archive data into product-type rows and training-data rows
 * ready for restore. Handles two archive shapes:
 *  - New archives carry a `product_types.json` and training rows reference a
 *    `productTypeId`; both are restored verbatim (ids preserved for FK safety).
 *  - Pre-migration archives have no product_types file and training rows carry
 *    a `productType` enum string; this synthesises product-type rows from the
 *    distinct strings and rewrites each training row to a `productTypeId`.
 */
export function prepareBackupRestore(
  productTypesJson: { id: number; name: string }[] | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trainingDataJson: any[]
): {
  productTypeRows: { id: number; name: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trainingDataRows: any[];
} {
  if (productTypesJson && productTypesJson.length > 0) {
    return { productTypeRows: productTypesJson, trainingDataRows: trainingDataJson };
  }

  const nameToId = new Map<string, number>();
  const productTypeRows: { id: number; name: string }[] = [];
  let nextId = 1;
  const trainingDataRows = trainingDataJson.map((row) => {
    if (row.productTypeId != null) return row;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { productType, ...rest } = row;
    const name = (typeof productType === "string" && productType.trim()) || "Unspecified";
    let id = nameToId.get(name);
    if (id === undefined) {
      id = nextId++;
      nameToId.set(name, id);
      productTypeRows.push({ id, name });
    }
    return { ...rest, productTypeId: id };
  });
  return { productTypeRows, trainingDataRows };
}
