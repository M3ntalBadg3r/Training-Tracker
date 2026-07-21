export interface StudentRow {
  email: string;
  fullName: string;
  theatre: string;
  country: string;
  region?: string | null;
  companyId?: number;
  companyName?: string | null;
}

export interface StudentRecord extends StudentRow {
  trainings: StudentTrainingRow[];
}

export interface StudentTrainingRow {
  id: number;
  fullTitle: string;
  link: string | null;
  trainingType: string;
  productType: string;
  function: string;
  completedDate: string;
  expiryDate: string;
  active: boolean;
  // OLX-specific flags. `isSubItem` indicates this is an OLXSubItem row;
  // `rolledUpUnderParent` indicates the student has also completed the
  // parent OLX, so the sub-item should be hidden from the top-level list
  // (it's shown nested under the parent instead).
  isSubItem?: boolean;
  rolledUpUnderParent?: boolean;
  parents?: string[];
  // Legacy lifecycle (Certification/Accreditation only). `isLegacy` marks the
  // held training as retired/superseded; `replacedBy` lists the replacement(s)
  // as display fullTitles.
  isLegacy?: boolean;
  replacedBy?: string[];
}

export interface TrainingAvailableRow {
  fullTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  link: string | null;
  studentsTaken: number;
}

export interface TrainingTakenRow {
  fullName: string;
  email: string;
  theatre: string;
  region: string;
  country: string;
  active: boolean;
  completedDate: string;
  expiryDate: string;
}

export interface RegionDataRow {
  country: string;
  region: string;
  theatre: string | null;
}

export interface CountryOption {
  country: string;
  region: string;
  theatre: string | null;
}

export interface TrainingDataRow {
  trainingTitle: string;
  fullTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  link: string | null;
  certification: string[];
  // Legacy lifecycle (Certification/Accreditation only). `isLegacy` marks the
  // cert/accreditation as retired/superseded; `replacedBy` lists the
  // trainingTitles of the replacement(s) (alternatives — any one counts).
  isLegacy: boolean;
  replacedBy: string[];
  isIncomplete: boolean;
  // OLX parent ↔ sub-item relationships. Both empty for non-OLX entries.
  // For an OLX parent: subItems lists the sub-item training titles.
  // For an OLX sub-item: parents lists the parent training titles it belongs to.
  subItems?: string[];
  parents?: string[];
}

export interface ImportSummary {
  studentsCreated: number;
  studentsUpdated: number;
  trainingsCreated: number;
  trainingsSkipped: number;
  trainingsAutoCreated: number;
  companiesCreated?: number;
  companyConflicts?: number;
  dateFormatUsed?: string;
  errors: string[];
}

export interface SpecialisationRow {
  id: number;
  name: string;
}

export interface ProgramDataAlternativeRow {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}

export interface ProgramSummaryRow {
  name: string;
  requirementCount: number;
  specialisations: string[];
  levels: string[];
  hasMinimumPerTheatre: boolean;
  isTiered: boolean;
  deploymentMode: string;
  tierCount: number;
}

export interface ProgramTierRow {
  id: number;
  programName: string;
  name: string;
  sortOrder: number;
  specialisationsRequired: number;
}

export interface ProgramDataRow {
  id: number;
  programName: string;
  specialisationId: number | null;
  specialisationName: string | null;
  tierId: number | null;
  tierName: string | null;
  purpose: string;
  level: string;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string | null;
  quantityRequired: number;
  minimumPerTheatre: number | null;
  alternatives: ProgramDataAlternativeRow[];
}


// --- Offerings ---
export interface OfferingDataAlternativeRow {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}

export interface OfferingSummaryRow {
  id: number;
  companyId: number;
  companyName: string | null;
  name: string;
  description: string | null;
  link: string | null;
  specialisations: string[];
  requirementCount: number;
}

export interface OfferingDataRow {
  id: number;
  offeringId: number;
  offeringName: string;
  companyId: number | null;
  specialisationId: number;
  specialisationName: string | null;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string | null;
  quantityRequired: number;
  alternatives: OfferingDataAlternativeRow[];
}

export interface ColumnDef<T> {
  key: string;
  header: string;
  sortable?: boolean;
  filterable?: boolean;
  filterOptions?: string[];
  render?: (row: T) => React.ReactNode;
  accessor?: (row: T) => string | number | boolean | null | undefined;
}
