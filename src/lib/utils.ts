export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

export function computeExpiryDate(completedDate: Date): Date {
  return addYears(completedDate, 2);
}

export function isActive(expiryDate: Date): boolean {
  return new Date(expiryDate) >= new Date();
}

export function formatDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function parseDate(dateStr: string): Date | null {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

export function trainingTypeLabel(value: string): string {
  const map: Record<string, string> = {
    Certification: "Certification",
    Accreditation: "Accreditation",
    InstructorLedTraining: "Instructor-Led Training",
  };
  return map[value] || value;
}

export function functionTypeLabel(value: string): string {
  const map: Record<string, string> = {
    Sales: "Sales",
    PreSales: "Pre-Sales",
    Deployments: "Deployments",
  };
  return map[value] || value;
}
