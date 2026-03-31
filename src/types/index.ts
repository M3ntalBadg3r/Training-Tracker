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
}

export interface TrainingDataRow {
  trainingTitle: string;
  fullTitle: string;
  trainingType: string;
  productType: string;
  function: string;
  link: string | null;
  certification: string[];
}

export interface ImportSummary {
  studentsCreated: number;
  studentsUpdated: number;
  trainingsCreated: number;
  trainingsSkipped: number;
  errors: string[];
}

export interface SpecialisationRow {
  id: number;
  name: string;
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
}

export interface APSRequirement {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
  quantityRequired: number;
  level: string;
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

export interface ColumnDef<T> {
  key: string;
  header: string;
  sortable?: boolean;
  filterable?: boolean;
  filterOptions?: string[];
  render?: (row: T) => React.ReactNode;
  accessor?: (row: T) => string | number | boolean | null | undefined;
}
