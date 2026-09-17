/**
 * ISO 3166-1 alpha-2 country codes and their English short names, plus a small
 * alias table for the spellings a sales geography tends to use ("UK", "USA",
 * "Korea, Republic of").
 *
 * This is a plain data module on purpose — no runtime dependency, which is a
 * standing project rule. The codes and names are ISO 3166-1, published
 * reference data; nothing here is customer, partner or product specific.
 *
 * It exists to power the *suggestion* helper on /admin/region-data. A
 * suggestion is a proposal a human approves, never an automatic write: an
 * auto-match is exactly the silent-mismatch surface `RegionData.isoCode` was
 * added to eliminate, so `suggestIsoCode` is deliberately conservative and
 * returns null rather than guessing.
 */

/** One canonical ISO 3166-1 entry. */
export interface IsoCountry {
  /** ISO 3166-1 alpha-2, uppercase. */
  code: string;
  /** English short name as published. */
  name: string;
}

/** The shape a route/DB write must satisfy. Mirrors the DB CHECK constraint. */
export const ISO_ALPHA2_PATTERN = /^[A-Z]{2}$/;

/**
 * Normalise an `isoCode` candidate for storage: trim, uppercase, and return
 * null for anything empty. Returns `undefined` when the value is present but
 * not two letters, which callers must treat as a rejection — `null` is the
 * legitimate "unmapped" state and must never stand in for invalid input.
 */
export function normaliseIsoCode(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  return ISO_ALPHA2_PATTERN.test(upper) ? upper : undefined;
}

/** The canonical list. 249 officially assigned alpha-2 codes. */
export const ISO_COUNTRIES: IsoCountry[] = [
  { code: "AD", name: "Andorra" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "AF", name: "Afghanistan" },
  { code: "AG", name: "Antigua and Barbuda" },
  { code: "AI", name: "Anguilla" },
  { code: "AL", name: "Albania" },
  { code: "AM", name: "Armenia" },
  { code: "AO", name: "Angola" },
  { code: "AQ", name: "Antarctica" },
  { code: "AR", name: "Argentina" },
  { code: "AS", name: "American Samoa" },
  { code: "AT", name: "Austria" },
  { code: "AU", name: "Australia" },
  { code: "AW", name: "Aruba" },
  { code: "AX", name: "Åland Islands" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BA", name: "Bosnia and Herzegovina" },
  { code: "BB", name: "Barbados" },
  { code: "BD", name: "Bangladesh" },
  { code: "BE", name: "Belgium" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BG", name: "Bulgaria" },
  { code: "BH", name: "Bahrain" },
  { code: "BI", name: "Burundi" },
  { code: "BJ", name: "Benin" },
  { code: "BL", name: "Saint Barthélemy" },
  { code: "BM", name: "Bermuda" },
  { code: "BN", name: "Brunei Darussalam" },
  { code: "BO", name: "Bolivia, Plurinational State of" },
  { code: "BQ", name: "Bonaire, Sint Eustatius and Saba" },
  { code: "BR", name: "Brazil" },
  { code: "BS", name: "Bahamas" },
  { code: "BT", name: "Bhutan" },
  { code: "BV", name: "Bouvet Island" },
  { code: "BW", name: "Botswana" },
  { code: "BY", name: "Belarus" },
  { code: "BZ", name: "Belize" },
  { code: "CA", name: "Canada" },
  { code: "CC", name: "Cocos (Keeling) Islands" },
  { code: "CD", name: "Congo, the Democratic Republic of the" },
  { code: "CF", name: "Central African Republic" },
  { code: "CG", name: "Congo" },
  { code: "CH", name: "Switzerland" },
  { code: "CI", name: "Côte d'Ivoire" },
  { code: "CK", name: "Cook Islands" },
  { code: "CL", name: "Chile" },
  { code: "CM", name: "Cameroon" },
  { code: "CN", name: "China" },
  { code: "CO", name: "Colombia" },
  { code: "CR", name: "Costa Rica" },
  { code: "CU", name: "Cuba" },
  { code: "CV", name: "Cabo Verde" },
  { code: "CW", name: "Curaçao" },
  { code: "CX", name: "Christmas Island" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DE", name: "Germany" },
  { code: "DJ", name: "Djibouti" },
  { code: "DK", name: "Denmark" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "DZ", name: "Algeria" },
  { code: "EC", name: "Ecuador" },
  { code: "EE", name: "Estonia" },
  { code: "EG", name: "Egypt" },
  { code: "EH", name: "Western Sahara" },
  { code: "ER", name: "Eritrea" },
  { code: "ES", name: "Spain" },
  { code: "ET", name: "Ethiopia" },
  { code: "FI", name: "Finland" },
  { code: "FJ", name: "Fiji" },
  { code: "FK", name: "Falkland Islands (Malvinas)" },
  { code: "FM", name: "Micronesia, Federated States of" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FR", name: "France" },
  { code: "GA", name: "Gabon" },
  { code: "GB", name: "United Kingdom of Great Britain and Northern Ireland" },
  { code: "GD", name: "Grenada" },
  { code: "GE", name: "Georgia" },
  { code: "GF", name: "French Guiana" },
  { code: "GG", name: "Guernsey" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GL", name: "Greenland" },
  { code: "GM", name: "Gambia" },
  { code: "GN", name: "Guinea" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "GR", name: "Greece" },
  { code: "GS", name: "South Georgia and the South Sandwich Islands" },
  { code: "GT", name: "Guatemala" },
  { code: "GU", name: "Guam" },
  { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" },
  { code: "HK", name: "Hong Kong" },
  { code: "HM", name: "Heard Island and McDonald Islands" },
  { code: "HN", name: "Honduras" },
  { code: "HR", name: "Croatia" },
  { code: "HT", name: "Haiti" },
  { code: "HU", name: "Hungary" },
  { code: "ID", name: "Indonesia" },
  { code: "IE", name: "Ireland" },
  { code: "IL", name: "Israel" },
  { code: "IM", name: "Isle of Man" },
  { code: "IN", name: "India" },
  { code: "IO", name: "British Indian Ocean Territory" },
  { code: "IQ", name: "Iraq" },
  { code: "IR", name: "Iran, Islamic Republic of" },
  { code: "IS", name: "Iceland" },
  { code: "IT", name: "Italy" },
  { code: "JE", name: "Jersey" },
  { code: "JM", name: "Jamaica" },
  { code: "JO", name: "Jordan" },
  { code: "JP", name: "Japan" },
  { code: "KE", name: "Kenya" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "KH", name: "Cambodia" },
  { code: "KI", name: "Kiribati" },
  { code: "KM", name: "Comoros" },
  { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "KP", name: "Korea, Democratic People's Republic of" },
  { code: "KR", name: "Korea, Republic of" },
  { code: "KW", name: "Kuwait" },
  { code: "KY", name: "Cayman Islands" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "LA", name: "Lao People's Democratic Republic" },
  { code: "LB", name: "Lebanon" },
  { code: "LC", name: "Saint Lucia" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LK", name: "Sri Lanka" },
  { code: "LR", name: "Liberia" },
  { code: "LS", name: "Lesotho" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "LV", name: "Latvia" },
  { code: "LY", name: "Libya" },
  { code: "MA", name: "Morocco" },
  { code: "MC", name: "Monaco" },
  { code: "MD", name: "Moldova, Republic of" },
  { code: "ME", name: "Montenegro" },
  { code: "MF", name: "Saint Martin (French part)" },
  { code: "MG", name: "Madagascar" },
  { code: "MH", name: "Marshall Islands" },
  { code: "MK", name: "North Macedonia" },
  { code: "ML", name: "Mali" },
  { code: "MM", name: "Myanmar" },
  { code: "MN", name: "Mongolia" },
  { code: "MO", name: "Macao" },
  { code: "MP", name: "Northern Mariana Islands" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MS", name: "Montserrat" },
  { code: "MT", name: "Malta" },
  { code: "MU", name: "Mauritius" },
  { code: "MV", name: "Maldives" },
  { code: "MW", name: "Malawi" },
  { code: "MX", name: "Mexico" },
  { code: "MY", name: "Malaysia" },
  { code: "MZ", name: "Mozambique" },
  { code: "NA", name: "Namibia" },
  { code: "NC", name: "New Caledonia" },
  { code: "NE", name: "Niger" },
  { code: "NF", name: "Norfolk Island" },
  { code: "NG", name: "Nigeria" },
  { code: "NI", name: "Nicaragua" },
  { code: "NL", name: "Netherlands, Kingdom of the" },
  { code: "NO", name: "Norway" },
  { code: "NP", name: "Nepal" },
  { code: "NR", name: "Nauru" },
  { code: "NU", name: "Niue" },
  { code: "NZ", name: "New Zealand" },
  { code: "OM", name: "Oman" },
  { code: "PA", name: "Panama" },
  { code: "PE", name: "Peru" },
  { code: "PF", name: "French Polynesia" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PH", name: "Philippines" },
  { code: "PK", name: "Pakistan" },
  { code: "PL", name: "Poland" },
  { code: "PM", name: "Saint Pierre and Miquelon" },
  { code: "PN", name: "Pitcairn" },
  { code: "PR", name: "Puerto Rico" },
  { code: "PS", name: "Palestine, State of" },
  { code: "PT", name: "Portugal" },
  { code: "PW", name: "Palau" },
  { code: "PY", name: "Paraguay" },
  { code: "QA", name: "Qatar" },
  { code: "RE", name: "Réunion" },
  { code: "RO", name: "Romania" },
  { code: "RS", name: "Serbia" },
  { code: "RU", name: "Russian Federation" },
  { code: "RW", name: "Rwanda" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SB", name: "Solomon Islands" },
  { code: "SC", name: "Seychelles" },
  { code: "SD", name: "Sudan" },
  { code: "SE", name: "Sweden" },
  { code: "SG", name: "Singapore" },
  { code: "SH", name: "Saint Helena, Ascension and Tristan da Cunha" },
  { code: "SI", name: "Slovenia" },
  { code: "SJ", name: "Svalbard and Jan Mayen" },
  { code: "SK", name: "Slovakia" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SM", name: "San Marino" },
  { code: "SN", name: "Senegal" },
  { code: "SO", name: "Somalia" },
  { code: "SR", name: "Suriname" },
  { code: "SS", name: "South Sudan" },
  { code: "ST", name: "Sao Tome and Principe" },
  { code: "SV", name: "El Salvador" },
  { code: "SX", name: "Sint Maarten (Dutch part)" },
  { code: "SY", name: "Syrian Arab Republic" },
  { code: "SZ", name: "Eswatini" },
  { code: "TC", name: "Turks and Caicos Islands" },
  { code: "TD", name: "Chad" },
  { code: "TF", name: "French Southern Territories" },
  { code: "TG", name: "Togo" },
  { code: "TH", name: "Thailand" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TK", name: "Tokelau" },
  { code: "TL", name: "Timor-Leste" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TN", name: "Tunisia" },
  { code: "TO", name: "Tonga" },
  { code: "TR", name: "Türkiye" },
  { code: "TT", name: "Trinidad and Tobago" },
  { code: "TV", name: "Tuvalu" },
  { code: "TW", name: "Taiwan, Province of China" },
  { code: "TZ", name: "Tanzania, United Republic of" },
  { code: "UA", name: "Ukraine" },
  { code: "UG", name: "Uganda" },
  { code: "UM", name: "United States Minor Outlying Islands" },
  { code: "US", name: "United States of America" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VA", name: "Holy See" },
  { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "VE", name: "Venezuela, Bolivarian Republic of" },
  { code: "VG", name: "Virgin Islands, British" },
  { code: "VI", name: "Virgin Islands, U.S." },
  { code: "VN", name: "Viet Nam" },
  { code: "VU", name: "Vanuatu" },
  { code: "WF", name: "Wallis and Futuna" },
  { code: "WS", name: "Samoa" },
  { code: "YE", name: "Yemen" },
  { code: "YT", name: "Mayotte" },
  { code: "ZA", name: "South Africa" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
];

/**
 * Everyday spellings that are not the ISO short name. Deliberately limited to
 * unambiguous, widely used forms — a guess that needs a judgement call belongs
 * in the review queue as "no suggestion", not here.
 *
 * Note the sub-national entries near the end: a sales geography routinely
 * carries "England" and "Scotland" as separate rows, both mapping to GB. That
 * is why `isoCode` is deliberately not unique.
 */
export const ISO_NAME_ALIASES: { name: string; code: string }[] = [
  { name: "UK", code: "GB" },
  { name: "U.K.", code: "GB" },
  { name: "United Kingdom", code: "GB" },
  { name: "Great Britain", code: "GB" },
  { name: "Britain", code: "GB" },
  { name: "USA", code: "US" },
  { name: "U.S.A.", code: "US" },
  { name: "US", code: "US" },
  { name: "U.S.", code: "US" },
  { name: "United States", code: "US" },
  { name: "America", code: "US" },
  { name: "UAE", code: "AE" },
  { name: "U.A.E.", code: "AE" },
  { name: "South Korea", code: "KR" },
  { name: "Republic of Korea", code: "KR" },
  { name: "Korea", code: "KR" },
  { name: "North Korea", code: "KP" },
  { name: "Russia", code: "RU" },
  { name: "Vietnam", code: "VN" },
  { name: "Laos", code: "LA" },
  { name: "Syria", code: "SY" },
  { name: "Iran", code: "IR" },
  { name: "Bolivia", code: "BO" },
  { name: "Venezuela", code: "VE" },
  { name: "Tanzania", code: "TZ" },
  { name: "Moldova", code: "MD" },
  { name: "Macedonia", code: "MK" },
  { name: "Czech Republic", code: "CZ" },
  { name: "Slovak Republic", code: "SK" },
  { name: "Netherlands", code: "NL" },
  { name: "Holland", code: "NL" },
  { name: "Turkey", code: "TR" },
  { name: "Ivory Coast", code: "CI" },
  { name: "Cape Verde", code: "CV" },
  { name: "Swaziland", code: "SZ" },
  { name: "Burma", code: "MM" },
  { name: "East Timor", code: "TL" },
  { name: "Vatican City", code: "VA" },
  { name: "Palestine", code: "PS" },
  { name: "Brunei", code: "BN" },
  { name: "Taiwan", code: "TW" },
  { name: "Macau", code: "MO" },
  { name: "Democratic Republic of the Congo", code: "CD" },
  { name: "DR Congo", code: "CD" },
  { name: "Congo-Kinshasa", code: "CD" },
  { name: "Republic of the Congo", code: "CG" },
  { name: "Congo-Brazzaville", code: "CG" },
  { name: "Micronesia", code: "FM" },
  { name: "Falkland Islands", code: "FK" },
  { name: "Cocos Islands", code: "CC" },
  { name: "Saint Helena", code: "SH" },
  { name: "British Virgin Islands", code: "VG" },
  { name: "US Virgin Islands", code: "VI" },
  { name: "Sint Maarten", code: "SX" },
  { name: "Saint Martin", code: "MF" },
  { name: "Reunion", code: "RE" },
  { name: "Curacao", code: "CW" },
  { name: "Aland Islands", code: "AX" },
  { name: "Turkiye", code: "TR" },
  { name: "Sao Tome & Principe", code: "ST" },
  { name: "Trinidad & Tobago", code: "TT" },
  { name: "Antigua & Barbuda", code: "AG" },
  { name: "Bosnia", code: "BA" },
  { name: "Bosnia & Herzegovina", code: "BA" },
  // Sub-national sales geographies. These are why isoCode is not unique.
  { name: "England", code: "GB" },
  { name: "Scotland", code: "GB" },
  { name: "Wales", code: "GB" },
  { name: "Northern Ireland", code: "GB" },
  { name: "Hong Kong SAR", code: "HK" },
  { name: "Macao SAR", code: "MO" },
];

/**
 * Case-, punctuation-, accent- and whitespace-insensitive key for a country
 * name. "Côte d'Ivoire", "cote divoire" and "COTE D IVOIRE" all collapse to the
 * same key; a leading "the " is dropped so "The Bahamas" matches "Bahamas".
 */
export function normaliseCountryName(value: string): string {
  const folded = value
    .normalize("NFD")
    // Strip combining marks so accented spellings fold onto plain ASCII.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return folded.startsWith("the") && folded.length > 3 ? folded.slice(3) : folded;
}

/** normalised name -> code. Canonical names win over aliases on a collision. */
const NAME_INDEX: Map<string, { code: string; matchedName: string }> = (() => {
  const index = new Map<string, { code: string; matchedName: string }>();

  // Which pre-comma heads are shared by more than one country, DERIVED from the
  // table rather than listed here, so the guard cannot go stale when an entry is
  // added or renamed. Today it finds exactly two: "korea" (KP/KR) and
  // "virginislands" (VG/VI).
  const headCounts = new Map<string, number>();
  for (const entry of ISO_COUNTRIES) {
    const comma = entry.name.indexOf(",");
    if (comma <= 0) continue;
    const head = normaliseCountryName(entry.name.slice(0, comma));
    if (head) headCounts.set(head, (headCounts.get(head) ?? 0) + 1);
  }
  const AMBIGUOUS_COMMA_HEADS = new Set(
    [...headCounts].filter(([, n]) => n > 1).map(([head]) => head)
  );

  for (const alias of ISO_NAME_ALIASES) {
    index.set(normaliseCountryName(alias.name), {
      code: alias.code,
      matchedName: alias.name,
    });
  }
  for (const entry of ISO_COUNTRIES) {
    index.set(normaliseCountryName(entry.name), {
      code: entry.code,
      matchedName: entry.name,
    });
    // Also index the part before the first comma, so "Bolivia" reaches
    // "Bolivia, Plurinational State of". This is NOT unambiguous for every
    // entry, and an earlier comment here claimed it was: two heads are shared.
    // "korea" is resolved deliberately by an explicit alias (KR wins), but
    // "virginislands" is shared by VG and VI and would otherwise resolve to
    // whichever appears first in the array — offering "Virgin Islands, British"
    // for a row that meant the US ones. That is exactly the plausible-looking
    // wrong match this column exists to prevent, and a reviewer working through
    // a long list with Select-all would accept it. Ambiguous heads are
    // therefore skipped entirely: no suggestion beats a wrong one, because a
    // blank is visibly blank. Reach those via their explicit aliases.
    const comma = entry.name.indexOf(",");
    if (comma > 0) {
      const head = normaliseCountryName(entry.name.slice(0, comma));
      if (head && !AMBIGUOUS_COMMA_HEADS.has(head) && !index.has(head)) {
        index.set(head, { code: entry.code, matchedName: entry.name });
      }
    }
  }
  return index;
})();

/** Code -> canonical name, for rendering a stored code back to a country. */
const CODE_INDEX: Map<string, string> = new Map(
  ISO_COUNTRIES.map((entry) => [entry.code, entry.name])
);

/** The ISO short name for a code, or null when the code is not assigned. */
export function isoCountryName(code: string): string | null {
  return CODE_INDEX.get(code.toUpperCase()) ?? null;
}

/** A conservative suggestion for one free-text country name. */
export interface IsoSuggestion {
  /** ISO 3166-1 alpha-2, uppercase. */
  code: string;
  /** The canonical name or alias the input matched, so a human can judge it. */
  matchedName: string;
}

/**
 * Suggest an ISO code for a free-text country name. Exact normalised matches
 * against the canonical names and the alias table only — no fuzzy scoring. A
 * name with no confident match returns null, which the caller reports as "no
 * suggestion" rather than guessing.
 *
 * A two-letter input that is itself an assigned code is accepted, so a
 * geography already recorded as "GB" resolves rather than being reported as
 * unmatched.
 */
export function suggestIsoCode(countryName: string): IsoSuggestion | null {
  const raw = countryName.trim();
  if (!raw) return null;

  const direct = NAME_INDEX.get(normaliseCountryName(raw));
  if (direct) return direct;

  const upper = raw.toUpperCase();
  if (ISO_ALPHA2_PATTERN.test(upper)) {
    const name = CODE_INDEX.get(upper);
    if (name) return { code: upper, matchedName: name };
  }

  return null;
}
