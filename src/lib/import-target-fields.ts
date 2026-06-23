// Shared definition of the student-import target fields. Both the import
// wizard (src/app/admin/import/page.tsx) and the alias admin API
// (src/app/api/admin/import-aliases) import the same key + label list so
// validation and UI stay aligned.

export const IMPORT_TARGET_FIELDS = [
  { key: "fullName", label: "Full Name", required: false },
  { key: "firstName", label: "First Name", required: false },
  { key: "lastName", label: "Last Name", required: false },
  { key: "email", label: "Email Address", required: true },
  { key: "theatre", label: "Theatre", required: true },
  { key: "country", label: "Country", required: true },
  { key: "title", label: "Cert/Training", required: true },
  { key: "completedDate", label: "Completed Date", required: true },
  { key: "company", label: "Company", required: false },
] as const;

export type ImportTargetFieldKey = (typeof IMPORT_TARGET_FIELDS)[number]["key"];

export const IMPORT_TARGET_FIELD_KEYS: ImportTargetFieldKey[] =
  IMPORT_TARGET_FIELDS.map((f) => f.key);

export function isImportTargetFieldKey(value: unknown): value is ImportTargetFieldKey {
  return typeof value === "string" && (IMPORT_TARGET_FIELD_KEYS as string[]).includes(value);
}

export function importTargetFieldLabel(key: ImportTargetFieldKey): string {
  return IMPORT_TARGET_FIELDS.find((f) => f.key === key)?.label ?? key;
}
