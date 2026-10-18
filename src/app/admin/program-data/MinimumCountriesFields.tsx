"use client";

/**
 * The program's two default minimum-countries settings, shared by the New
 * Program modal and the program page's settings card so they read (and
 * validate) the same:
 *  - **Minimum countries — By Country Set view**: how many countries the
 *    partner's Country Set must hold before any tier is reached in that view.
 *  - **Minimum target countries — By Theatre view**: how many of the partner's
 *    target countries must lie inside the viewed theatre before any tier is
 *    reached there. Applies only when the program has Target countries
 *    requirements.
 * Each is the default for a partner with no number of its own in Program
 * Partners.
 *
 * Values are kept as the raw input text so a half-typed value is not coerced;
 * the server parses them strictly (a whole number 1–1000, blank = none).
 */
export interface MinimumCountriesValue {
  countrySetMinimum: string;
  targetMinimum: string;
}

export const EMPTY_MINIMUMS: MinimumCountriesValue = { countrySetMinimum: "", targetMinimum: "" };

/** Request-body form: a blank input is an explicit `null` (clear). */
export function minimumsBody(v: MinimumCountriesValue) {
  return {
    countrySetMinimumCountries: v.countrySetMinimum.trim() || null,
    targetMinimumCountries: v.targetMinimum.trim() || null,
  };
}

export function minimumsFromProgram(p: {
  countrySetMinimumCountries: number | null;
  targetMinimumCountries: number | null;
} | null | undefined): MinimumCountriesValue {
  return {
    countrySetMinimum: p?.countrySetMinimumCountries != null ? String(p.countrySetMinimumCountries) : "",
    targetMinimum: p?.targetMinimumCountries != null ? String(p.targetMinimumCountries) : "",
  };
}

const INPUT_CLASS = "w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm";

export default function MinimumCountriesFields({
  value,
  onChange,
  idPrefix,
}: {
  value: MinimumCountriesValue;
  onChange: (next: MinimumCountriesValue) => void;
  idPrefix: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-cs-minimum`} className="block text-sm font-medium mb-1">
          Minimum countries — By Country Set view <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-cs-minimum`}
          type="number"
          min={1}
          max={1000}
          step={1}
          value={value.countrySetMinimum}
          onChange={(e) => onChange({ ...value, countrySetMinimum: e.target.value })}
          placeholder="No minimum"
          className={INPUT_CLASS}
        />
        <p className="mt-1 text-xs text-gray-500">
          How many countries a partner&apos;s Country Set must hold before any tier is reached in the By Country Set
          view, unless their partner settings give their own number.
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-target-minimum`} className="block text-sm font-medium mb-1">
          Minimum target countries — By Theatre view <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-target-minimum`}
          type="number"
          min={1}
          max={1000}
          step={1}
          value={value.targetMinimum}
          onChange={(e) => onChange({ ...value, targetMinimum: e.target.value })}
          placeholder="No minimum"
          className={INPUT_CLASS}
        />
        <p className="mt-1 text-xs text-gray-500">
          How many of a partner&apos;s target countries must lie inside the viewed theatre before any tier is reached
          in the By Theatre view, unless their partner settings give their own number. Applies only when the program
          has Target countries requirements.
        </p>
      </div>
    </div>
  );
}
