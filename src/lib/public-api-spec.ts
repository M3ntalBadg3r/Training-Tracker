/**
 * The read-only public API, described once.
 *
 * Three consumers read this module and nothing else describes the surface:
 *  - `api/public/v1/route.ts` renders its self-describing `endpoints` index,
 *  - `api/public/v1/openapi.json/route.ts` serves `buildOpenApiDocument()`,
 *  - `scripts/check-api-spec.mjs` asserts it still matches the code, and that
 *    the committed `docs/openapi.json` is not stale.
 *
 * ## Why it exists
 *
 * The index used to be a hand-written array in the route file with nothing tying
 * it to the handlers, and it drifted: `training-records` was described as
 * "Per-completion training records" while the route had grown four filters no
 * caller could discover. One source plus a CI check turns that from a thing
 * someone has to remember into a thing that fails the build.
 *
 * ## Zero imports, deliberately
 *
 * Like `lib/csp.ts` and `lib/roles.ts`, this module imports nothing — and here
 * the reason is mechanical. `scripts/generate-openapi.mjs` imports it directly
 * with Node's native TypeScript type stripping (22.18+; verified on 22.22, and
 * every CI job pins `node-version: 22`). Stripping is not compiling: there is no
 * module resolution for a `@/` path alias, so one import would break the
 * generator and the check with it. Keep it import-free.
 *
 * ## Response schemas are hand-written
 *
 * They are not derived from the TypeScript types, so they can lie if someone
 * changes a handler and not this file. The CI check covers *parameters* (it can
 * read `.get("…")` out of the source); response shapes are on the author. Where
 * the code genuinely does not guarantee a shape — `ReportResult.data` is
 * `any[]` — the schema says so rather than inventing one.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PublicApiParam {
  name: string;
  in: "query" | "path";
  required?: boolean;
  /**
   * `"guard"` marks a parameter consumed by `authorizePublicRequest` rather than
   * the handler — `companyId` is the only one. The check skips the "is this
   * actually read?" assertion for these, because no `.get()` call appears in the
   * route file for them.
   */
  source?: "guard";
  description: string;
  schema: {
    type: "string" | "integer" | "boolean";
    enum?: readonly (string | number)[];
    default?: string | number | boolean;
  };
}

export interface PublicApiEndpoint {
  /** The URL path, with `{braces}` for path parameters. */
  path: string;
  /** Path of the handler relative to `src/app/api/public/v1/`. Ties the entry to real code. */
  routeFile: string;
  /**
   * Extra files whose `.get("…")` reads belong to this endpoint. `programs/planning`
   * reads only `options` itself and delegates the other seven parameters to
   * `parsePlanRequest`, so a check that scanned route files alone would report a
   * clean pass on the endpoint with the most parameters.
   */
  paramSources?: readonly string[];
  summary: string;
  description: string;
  parameters: readonly PublicApiParam[];
  /** JSON Schema for the 200 body. */
  responseSchema: Record<string, unknown>;
  /** Extra non-guard responses, keyed by status code. */
  errors?: Readonly<Record<string, string>>;
}

// ─── Shared parameters ───────────────────────────────────────────────────────

const COMPANY_ID: PublicApiParam = {
  name: "companyId",
  in: "query",
  source: "guard",
  description:
    "Narrow the response to one of the key's granted companies. Omitted or non-numeric, the response covers every company the key can read. A numeric id the key was NOT granted yields an empty result rather than an error.",
  schema: { type: "integer" },
};

const GEO_PARAMS: readonly PublicApiParam[] = [
  {
    name: "country",
    in: "query",
    description: "Scope to one country. Narrowest selection wins: country over region over theatre.",
    schema: { type: "string" },
  },
  {
    name: "region",
    in: "query",
    description: "Scope to one region. Ignored when country is supplied.",
    schema: { type: "string" },
  },
  {
    name: "theatre",
    in: "query",
    description: "Scope to one theatre. Ignored when country or region is supplied.",
    schema: { type: "string" },
  },
];

// ─── Reusable schema fragments ───────────────────────────────────────────────

const STR = { type: "string" } as const;
const NUM = { type: "number" } as const;
const INT = { type: "integer" } as const;
const BOOL = { type: "boolean" } as const;
const NULLABLE_STR = { type: ["string", "null"] } as const;
const NULLABLE_NUM = { type: ["number", "null"] } as const;
const NULLABLE_BOOL = { type: ["boolean", "null"] } as const;

function obj(properties: Record<string, unknown>, required?: readonly string[]) {
  return required ? { type: "object", properties, required } : { type: "object", properties };
}
function arr(items: Record<string, unknown>) {
  return { type: "array", items };
}

const ALTERNATIVE = obj({
  trainingType: STR,
  trainingTitle: STR,
  trainingFullTitle: NULLABLE_STR,
});

const PLAN_REQUIREMENT = obj({
  instanceId: STR,
  specialisation: NULLABLE_STR,
  tierName: NULLABLE_STR,
  purpose: STR,
  nativeLevel: { type: "string", description: "The requirement's authored level: Country, Theatre or Global." },
  scopeLabel: { type: "string", description: "The population this instance is counted over." },
  cert: STR,
  required: INT,
  attained: INT,
  projectedAttained: { type: ["integer", "null"], description: "Holders still active at the end of the renewal window. Null when no window is selected." },
  shortfall: { type: "integer", description: "Today's gap. Independent of planForWindow." },
  projectedShortfall: { type: ["integer", "null"] },
  renewalPool: INT,
  easyWinPool: INT,
  lapsedPool: INT,
  legacyPool: INT,
  netNew: { type: "integer", description: "Slots needing brand-new training, true of this requirement read alone." },
  sharedWith: { ...arr(STR), description: "Other specialisations in this target needing the same certification over the same population." },
  expiringSoon: INT,
});

const PLAN_SPECIALISATION = obj({
  name: STR,
  achieved: BOOL,
  projectedAchieved: NULLABLE_BOOL,
  cost: INT,
  easyWins: INT,
  requirements: arr(PLAN_REQUIREMENT),
  chosen: { type: "boolean", description: "For a tier target: one of the cheapest specialisations this plan costed against." },
  alternative: { type: "boolean", description: "For a tier target: an equal-cost swap for a chosen specialisation." },
  marginalCost: INT,
});

const PLAN_TARGET = obj({
  program: STR,
  mode: { type: "string", enum: ["tier", "specialisations", "all"] },
  isTiered: BOOL,
  tierName: NULLABLE_STR,
  headline: STR,
  tierPlan: obj({
    specialisationsRequired: INT,
    alreadyAchieved: INT,
    needed: INT,
    deliveryCertShortfall: INT,
  }),
  specialisations: arr(PLAN_SPECIALISATION),
  peopleMoves: INT,
  easyWins: INT,
  netNew: INT,
});

const PLAN_RISK_IMPACT = obj({
  program: STR,
  specialisation: NULLABLE_STR,
  tierName: NULLABLE_STR,
  cert: STR,
  scopeLabel: STR,
  required: INT,
  attained: INT,
  projectedAttained: INT,
  onPath: { type: "boolean", description: "Whether the plan is costed against this requirement." },
});

const PROGRAM_REQUIREMENT = obj({
  trainingType: NULLABLE_STR,
  trainingTitle: NULLABLE_STR,
  trainingFullTitle: { type: "string", description: 'Falls back to "—" when the training has been deleted.' },
  quantityRequired: INT,
  attained: INT,
  projectedAttained: { type: ["integer", "null"] },
  alternatives: arr(ALTERNATIVE),
  globalAttained: { type: "integer", description: "Global level only." },
  minimumPerTheatre: { type: ["integer", "null"], description: "Global level only." },
  theatreBreakdown: { type: "object", description: "Global level only: holders per theatre.", additionalProperties: INT },
  compliant: { type: "boolean", description: "Global level only." },
});

// ─── Endpoints ───────────────────────────────────────────────────────────────

export const PUBLIC_API_ENDPOINTS: readonly PublicApiEndpoint[] = [
  {
    path: "/api/public/v1",
    routeFile: "route.ts",
    summary: "Index",
    description:
      "Confirms the key works and reports which companies it can read, plus the available endpoints. This route does not accept ?companyId= — it always reports the key's full grant.",
    parameters: [],
    responseSchema: obj({
      name: STR,
      version: STR,
      keyName: STR,
      companies: arr(obj({ id: INT, name: STR }, ["id", "name"])),
      endpoints: arr(obj({ method: STR, path: STR, description: STR })),
      notes: STR,
    }),
  },

  {
    path: "/api/public/v1/openapi.json",
    routeFile: "openapi.json/route.ts",
    summary: "OpenAPI description",
    description:
      "This document, as OpenAPI 3.1. Key-gated like every other endpoint; a copy is committed at docs/openapi.json for reading before you hold a key.",
    parameters: [],
    responseSchema: {
      type: "object",
      description: "An OpenAPI 3.1 document.",
      additionalProperties: true,
    },
  },

  {
    path: "/api/public/v1/students",
    routeFile: "students/route.ts",
    summary: "Student roster",
    description: "Every learner in the key's companies, ordered by name.",
    parameters: [COMPANY_ID],
    responseSchema: arr(
      obj({
        email: STR,
        fullName: STR,
        theatre: STR,
        country: STR,
        region: { ...NULLABLE_STR, description: "Null when the country has no region configured." },
        companyId: INT,
        companyName: NULLABLE_STR,
      })
    ),
  },

  {
    path: "/api/public/v1/training-records",
    routeFile: "training-records/route.ts",
    summary: "Per-completion training records",
    description:
      "The latest completion per learner and training, with the learner's geography. OLX sub-items are excluded so they never double-count with their parent.",
    parameters: [
      COMPANY_ID,
      ...GEO_PARAMS,
      {
        name: "activeOnly",
        in: "query",
        description: "Set to true to return only records that have not expired.",
        schema: { type: "boolean", default: false },
      },
    ],
    responseSchema: arr(
      obj({
        fullName: STR,
        email: STR,
        theatre: STR,
        region: { type: "string", description: 'Empty string when the country has no region configured.' },
        country: STR,
        trainingTitle: STR,
        trainingType: { type: "string", description: "Display label, e.g. Instructor-Led Training." },
        rawTrainingType: { type: "string", description: "The stored enum value, e.g. InstructorLedTraining." },
        productType: STR,
        function: STR,
        completedDate: { type: "string", format: "date" },
        expiryDate: { type: "string", format: "date" },
        active: { type: "string", enum: ["Yes", "No"], description: 'A string, not a boolean.' },
        isLegacy: BOOL,
      })
    ),
  },

  {
    path: "/api/public/v1/offerings",
    routeFile: "offerings/route.ts",
    summary: "Offering definitions",
    description:
      "Offerings for the key's companies, each with its specialisations and supporting trainings. Supplying ?country= or ?region= adds Onshore/Nearshore/Offshore holder counts and a scope block; without one, those per-requirement fields are omitted entirely rather than returned as zero.",
    parameters: [
      COMPANY_ID,
      {
        name: "name",
        in: "query",
        description: "Exact offering name — an exact match, not a substring search.",
        schema: { type: "string" },
      },
      {
        name: "country",
        in: "query",
        description: "Onshore country. Adds compliance counts.",
        schema: { type: "string" },
      },
      {
        name: "region",
        in: "query",
        description: "Onshore region. Adds compliance counts, and takes precedence over country.",
        schema: { type: "string" },
      },
    ],
    responseSchema: obj({
      scope: {
        ...obj({
          level: { type: "string", enum: ["country", "region"] },
          value: STR,
          onshoreCountries: arr(STR),
          nearshoreCountries: arr(STR),
          offshoreCountries: { ...arr(STR), description: "Every country minus onshore — a superset of nearshore." },
          hasNearshore: BOOL,
          hasOffshore: BOOL,
        }),
        description: "Present only when ?country= or ?region= was supplied.",
      },
      offerings: arr(
        obj({
          name: STR,
          companyId: INT,
          description: NULLABLE_STR,
          link: { ...NULLABLE_STR, description: "Null unless the stored link is http: or https:." },
          specialisations: arr(
            obj({
              name: STR,
              requirements: arr(
                obj({
                  trainingType: STR,
                  trainingTitle: STR,
                  trainingFullTitle: NULLABLE_STR,
                  quantityRequired: INT,
                  alternatives: arr(ALTERNATIVE),
                  onshore: { type: "integer", description: "Only with a scope." },
                  nearshore: { ...NULLABLE_NUM, description: "Only with a scope; null when the theatre has no other countries." },
                  offshore: { ...NULLABLE_NUM, description: "Only with a scope." },
                  met: { type: "boolean", description: "Only with a scope. Onshore holders >= quantityRequired." },
                })
              ),
            })
          ),
        })
      ),
    }),
  },

  {
    path: "/api/public/v1/programs",
    routeFile: "programs/route.ts",
    summary: "Partner program list",
    description:
      "Every configured program with the shape needed to query its compliance. Deliberately NOT company-scoped: programs are a global registry carrying no company dimension, and nothing per-company is returned. ?companyId= is accepted but changes nothing here.",
    parameters: [COMPANY_ID],
    responseSchema: obj({
      programs: arr(
        obj({
          name: STR,
          levels: { ...arr(STR), description: "Configured compliance levels: Country, Theatre, Global." },
          hasMinimumPerTheatre: BOOL,
          isTiered: BOOL,
        })
      ),
    }),
  },

  {
    path: "/api/public/v1/programs/{programName}",
    routeFile: "programs/[programName]/route.ts",
    summary: "Per-program compliance",
    description:
      "Compliance for one program at a chosen level and scope. Note that ?students=true only returns a roster when ?trainingTitle= is also supplied; on its own it returns the ordinary report. A tiered program additionally carries a tiers block.",
    parameters: [
      COMPANY_ID,
      {
        name: "programName",
        in: "path",
        required: true,
        description: "Percent-encoded program name.",
        schema: { type: "string" },
      },
      {
        name: "level",
        in: "query",
        description: "Which level to report at.",
        schema: { type: "string", enum: ["country", "region", "theatre", "global"], default: "country" },
      },
      ...GEO_PARAMS,
      {
        name: "horizonMonths",
        in: "query",
        description:
          "Project compliance forward by this many months, so upcoming expiries surface before they break compliance. Only 3, 6 and 12 are accepted; anything else means no projection.",
        schema: { type: "integer", enum: [3, 6, 12], default: 0 },
      },
      {
        name: "trainingTitle",
        in: "query",
        description: "Comma-separated training titles. With students=true, returns the holder roster for these.",
        schema: { type: "string" },
      },
      {
        name: "students",
        in: "query",
        description: "Set to true, together with trainingTitle, to return the holder roster instead of the report.",
        schema: { type: "boolean", default: false },
      },
    ],
    responseSchema: {
      oneOf: [
        {
          ...obj({
            specialisations: arr(
              obj({
                name: STR,
                requirements: arr(PROGRAM_REQUIREMENT),
                deploymentRequirements: arr(PROGRAM_REQUIREMENT),
                deploymentCompliant: BOOL,
                projectedDeploymentCompliant: BOOL,
              })
            ),
            countries: arr(STR),
            regions: arr(STR),
            theatres: arr(STR),
            meta: obj({
              levels: arr(STR),
              hasMinimumPerTheatre: BOOL,
              isTiered: { type: "boolean", description: "Absent from the empty out-of-scope payload." },
              deploymentMode: { type: "string", enum: ["flat", "perAchievedSpecialisation", "perTierPerSpecialisation"] },
            }),
            horizonMonths: INT,
            tiers: {
              ...obj({
                deploymentMode: STR,
                highestAchievedTier: NULLABLE_STR,
                projectedHighestAchievedTier: NULLABLE_STR,
                achievedSpecialisations: arr(STR),
                achievedSpecialisationCount: INT,
                projectedAchievedSpecialisationCount: { type: ["integer", "null"] },
                tiers: arr(
                  obj({
                    name: STR,
                    sortOrder: INT,
                    specialisationsRequired: INT,
                    compliant: BOOL,
                    projectedCompliant: NULLABLE_BOOL,
                    satisfiedSpecialisationCount: INT,
                    projectedSatisfiedSpecialisationCount: { type: ["integer", "null"] },
                    deploymentRequirements: arr(PROGRAM_REQUIREMENT),
                  })
                ),
              }),
              description: "Present only for a tiered program.",
            },
          }),
          title: "Compliance report",
        },
        {
          ...obj({
            students: arr(
              obj({
                fullName: STR,
                email: STR,
                country: STR,
                theatre: STR,
                completedDate: { type: "string", format: "date" },
                expiryDate: { type: "string", format: "date" },
                training: { type: "string", description: "The specific training this person holds, which may be an alternative or a catalogue variant." },
              })
            ),
          }),
          title: "Holder roster (students=true with trainingTitle)",
        },
      ],
    },
    errors: { "400": "Invalid program name — the path segment was not valid percent-encoding." },
  },

  {
    path: "/api/public/v1/programs/planning",
    routeFile: "programs/planning/route.ts",
    paramSources: ["src/lib/compliance-plan-request.ts"],
    summary: "Compliance planning (aggregates only)",
    description:
      "The action layer over program compliance: what it would take to close each gap. AGGREGATES ONLY — the named candidate, eligible-pool and renewal rosters the in-app planner shows are never returned over this API. Nothing analytical is lost: riskImpacts is the aggregate view of the same set the named renewal rows enumerate, and totals.renewalsAtRisk is its count. Use ?options=true first to discover the program, tier and specialisation names needed to build a targets array.",
    parameters: [
      COMPANY_ID,
      {
        name: "options",
        in: "query",
        description:
          "Set to true to return the selector metadata — per program, its tiers and specialisations — instead of a plan. This is the only way to learn the names a targets array must use.",
        schema: { type: "boolean", default: false },
      },
      {
        name: "targets",
        in: "query",
        description:
          'URL-encoded JSON array: [{"program":"…","mode":"tier"|"specialisations"|"all","tier":"…","specialisations":["…"]}]. Omitted, the response is an empty plan rather than an error. Unparseable JSON is a 400.',
        schema: { type: "string" },
      },
      {
        name: "level",
        in: "query",
        description: "The scope to plan at. Each scope plans against its own level's requirements only.",
        schema: { type: "string", enum: ["global", "theatre", "region", "country"], default: "global" },
      },
      ...GEO_PARAMS,
      {
        name: "renewalWindowMonths",
        in: "query",
        description: "Report compliance falling below target as training expires within this window. 0 disables the overlay.",
        schema: { type: "integer", enum: [0, 1, 3, 6, 12], default: 3 },
      },
      {
        name: "planForWindow",
        in: "query",
        description:
          "Size the gaps from the projected end-of-window holder count rather than today's, so training lapsing inside the window has to be renewed to count as closed. Forced false when renewalWindowMonths is 0.",
        schema: { type: "boolean", default: false },
      },
    ],
    responseSchema: {
      oneOf: [
        {
          ...obj({
            scopeLabel: STR,
            renewalWindowMonths: INT,
            planForWindow: BOOL,
            targets: arr(PLAN_TARGET),
            riskImpacts: arr(PLAN_RISK_IMPACT),
            totals: obj({
              peopleMoves: { type: "integer", description: 'The "people to certify" headline, deduped so one person\'s exam counts once.' },
              easyWins: INT,
              lapsed: INT,
              legacy: INT,
              netNew: INT,
              renewalMoves: INT,
              renewalsAtRisk: { type: "integer", description: "Person x certification, not distinct people." },
              renewalsAtRiskOnPath: INT,
            }),
          }),
          title: "Plan",
        },
        {
          ...obj({
            programs: arr(
              obj({
                name: STR,
                isTiered: BOOL,
                levels: arr(STR),
                tiers: arr(STR),
                specialisations: arr(STR),
              })
            ),
          }),
          title: "Selector metadata (options=true)",
        },
      ],
    },
    errors: { "400": "Invalid targets — the value was not parseable JSON." },
  },

  {
    path: "/api/public/v1/reports/{reportType}",
    routeFile: "reports/[reportType]/route.ts",
    summary: "Report aggregates",
    description:
      "One of eight pre-built reports. The row shape varies by report and is not type-enforced in the source, so data is described as free-form objects rather than a shape this API does not actually guarantee. Note expiring-soon is fixed at a 6-month horizon; no parameter changes it.",
    parameters: [
      COMPANY_ID,
      {
        name: "reportType",
        in: "path",
        required: true,
        description: "Which report to return.",
        schema: {
          type: "string",
          enum: [
            "trained-not-certified",
            "legacy-gap",
            "learner-scorecard",
            "by-product",
            "by-function",
            "expiring-soon",
            "currently-expired",
            "last-12-months",
          ],
        },
      },
    ],
    responseSchema: obj({
      reportType: STR,
      title: { type: "string", description: "The report's display title. Empty string when the key can read no companies." },
      data: { ...arr({ type: "object", additionalProperties: true }), description: "Row shape varies by report type." },
    }),
    errors: { "404": "Unknown report type. The body carries validReportTypes listing the accepted values." },
  },

  {
    path: "/api/public/v1/reports/program-compliance-trend",
    routeFile: "reports/program-compliance-trend/route.ts",
    summary: "Program compliance trend",
    description:
      "Twenty-four month-end snapshots per program and specialisation: twelve of history and twelve projected. Future months assume no new completions, so compliance decays as active certifications expire. A separate endpoint, not a value for {reportType}.",
    parameters: [
      COMPANY_ID,
      {
        name: "program",
        in: "query",
        description: "Narrow to one program. Omitted, every program is included.",
        schema: { type: "string" },
      },
      ...GEO_PARAMS,
    ],
    responseSchema: obj({
      snapshots: arr(
        obj({
          program: STR,
          specialisation: STR,
          monthKey: { type: "string", description: "YYYY-MM." },
          monthLabel: STR,
          attained: INT,
          required: INT,
          compliancePct: NUM,
          projected: { type: "boolean", description: "True for the twelve forecast months." },
        })
      ),
      programs: arr(STR),
      specialisations: arr(STR),
      scopeLabel: STR,
    }),
  },

  {
    path: "/api/public/v1/reports/renewal-forecast",
    routeFile: "reports/renewal-forecast/route.ts",
    summary: "Renewal forecast",
    description:
      "A twelve-month renewed-versus-lapsed projection with an at-risk-by-training breakdown. A renewal is a re-completion at least 30 days after the previous one; the rate is taken per training where there are at least five historical expiries, else per product, else global. A separate endpoint, not a value for {reportType}.",
    parameters: [COMPANY_ID, ...GEO_PARAMS],
    responseSchema: obj({
      monthly: arr(
        obj({
          monthKey: STR,
          monthLabel: STR,
          expiringCount: INT,
          projectedRenewed: INT,
          projectedLapsed: INT,
        })
      ),
      titleRows: arr(
        obj({
          fullTitle: STR,
          productType: STR,
          expiringCount: INT,
          rate: { type: "number", description: "Renewal rate as a percentage to one decimal place." },
          rateSource: { type: "string", enum: ["fullTitle", "product", "global"] },
          projectedLapsed: INT,
        })
      ),
      globalRate: NUM,
      historicalRenewed: INT,
      historicalLapsed: INT,
      scopeLabel: STR,
    }),
  },
] as const;

// ─── The index projection ────────────────────────────────────────────────────

/**
 * What the self-describing index renders. Derived here so the index and the
 * OpenAPI document cannot disagree about which endpoints exist.
 */
export interface IndexEndpoint {
  method: string;
  path: string;
  description: string;
  /**
   * The accepted values of a path parameter that has a closed set — today only
   * `/reports/{reportType}`. Kept under this name because the index has always
   * emitted `reportTypes` there and a consumer may read it; renaming it to
   * something generic would be a silent breaking change to a published payload.
   */
  reportTypes?: readonly (string | number)[];
}

export function buildIndexEndpoints(): IndexEndpoint[] {
  return PUBLIC_API_ENDPOINTS.filter((e) => e.path !== "/api/public/v1").map((e) => {
    const enumerated = e.parameters.find((p) => p.in === "path" && p.schema.enum);
    return {
      method: "GET",
      path: e.path,
      description: describeForIndex(e),
      ...(enumerated ? { reportTypes: enumerated.schema.enum } : {}),
    };
  });
}

/** One line naming the endpoint and the parameters a caller can actually pass. */
function describeForIndex(e: PublicApiEndpoint): string {
  const query = e.parameters
    .filter((p) => p.in === "query" && p.source !== "guard")
    .map((p) => `?${p.name}=`);
  const tail = query.length > 0 ? ` Parameters: ${query.join(", ")}.` : "";
  return `${e.summary}. ${e.description}${tail}`;
}

// ─── OpenAPI ─────────────────────────────────────────────────────────────────

const ERROR_SCHEMA = obj({ error: STR });

/** The guard-chain responses every endpoint shares. */
const COMMON_RESPONSES: Record<string, unknown> = {
  "401": {
    description: "Missing, invalid, disabled, revoked or expired API key.",
    content: { "application/json": { schema: ERROR_SCHEMA } },
  },
  "429": {
    description:
      "Rate limited — 120 requests per minute per key, or 20 invalid-key attempts per 5 minutes per IP.",
    content: { "application/json": { schema: ERROR_SCHEMA } },
  },
  "503": {
    description: "The public API is switched off for this installation. Checked before the key is even looked up.",
    content: { "application/json": { schema: ERROR_SCHEMA } },
  },
};

/**
 * The OpenAPI 3.1 document.
 *
 * `info.version` is the API version, deliberately not the application version:
 * the committed `docs/openapi.json` would otherwise change on every release and
 * turn a meaningful diff into noise.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const e of PUBLIC_API_ENDPOINTS) {
    paths[e.path] = {
      get: {
        summary: e.summary,
        description: e.description,
        operationId: operationIdFor(e.path),
        parameters: e.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.in === "path" ? true : (p.required ?? false),
          description: p.description,
          schema: p.schema,
        })),
        responses: {
          "200": {
            description: "Success.",
            content: { "application/json": { schema: e.responseSchema } },
          },
          ...Object.fromEntries(
            Object.entries(e.errors ?? {}).map(([code, description]) => [
              code,
              { description, content: { "application/json": { schema: ERROR_SCHEMA } } },
            ])
          ),
          ...COMMON_RESPONSES,
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Training Tracker Public API",
      version: "v1",
      description:
        "Read-only access to student, training, offering and partner-program data for the companies an API key has been granted.\n\n" +
        "Every endpoint is GET-only; there are no write endpoints under /api/public, so a leaked key can never modify data.\n\n" +
        "**The whole API ships switched off.** Until a SuperAdmin enables it under Admin → API Keys, every request returns 503 regardless of how many valid keys exist.\n\n" +
        "**Freshness:** the heavier endpoints are cached for up to 30 seconds and carry `Cache-Control: private, max-age=30`. Any change made in the app flushes that cache immediately, so you never see data from before an edit or an import — but polling faster than every 30 seconds returns the same bytes while still spending your rate-limit budget.",
    },
    servers: [{ url: "/", description: "This installation. Paths below are absolute." }],
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Send the key as `Authorization: Bearer <key>`.",
        },
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "Accepted as an alternative to the Authorization header.",
        },
      },
    },
    paths,
  };
}

/** A stable operationId from the path, e.g. /reports/{reportType} -> getReportsByReportType. */
function operationIdFor(path: string): string {
  const parts = path.replace("/api/public/v1", "").split("/").filter(Boolean);
  if (parts.length === 0) return "getIndex";
  const words = parts.map((part) => {
    const m = part.match(/^\{(.+)\}$/);
    const raw = m ? `by-${m[1]}` : part;
    return raw
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
  });
  return "get" + words.join("");
}
