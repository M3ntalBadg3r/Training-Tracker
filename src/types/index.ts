export interface StudentRow {
  email: string;
  fullName: string;
  theatre: string;
  country: string;
  region?: string | null;
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

export interface ProgramDataRow {
  id: number;
  programName: string;
  specialisationId: number;
  specialisationName: string;
  level: string;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string | null;
  quantityRequired: number;
  minimumPerTheatre: number | null;
  alternatives: ProgramDataAlternativeRow[];
}

export interface APSRequirement {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
  quantityRequired: number;
  level: string;
  alternatives: ProgramDataAlternativeRow[];
}

export interface APSSpecialisation {
  name: string;
  requirements: APSRequirement[];
}

export interface APSAttainedEntry {
  trainingTitle: string;
  count: number;
  students: { fullName: string; email: string; country: string; completedDate: string; expiryDate: string }[];
}

export interface APSReportData {
  specialisations: APSSpecialisation[];
  countryAttained: Record<string, APSAttainedEntry[]>;
  theatreAttained: Record<string, APSAttainedEntry[]>;
  globalCompliance: Record<string, number>;
  countries: string[];
  theatres: string[];
}

export interface GlobalDiamondTheatreBreakdown {
  theatre: string;
  count: number;
  compliant: boolean;
}

export interface GlobalDiamondRequirement {
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string;
  quantityRequired: number;
  globalAttained: number;
  minimumPerTheatre: number | null;
  theatreBreakdown: GlobalDiamondTheatreBreakdown[] | null;
  compliant: boolean;
  alternatives: ProgramDataAlternativeRow[];
}

export interface GlobalDiamondSpecialisation {
  name: string;
  compliant: boolean;
  requirements: GlobalDiamondRequirement[];
}

export interface GlobalDiamondReportData {
  specialisations: GlobalDiamondSpecialisation[];
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
