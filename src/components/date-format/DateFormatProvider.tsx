"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_DATE_FORMAT,
  formatDateTimeWith,
  formatDateWith,
  isDateFormat,
  type DateFormat,
} from "@/lib/date-format";
import { fetchMe } from "@/lib/fetch-me";

interface DateFormatContextValue {
  /** Effective format = user preference if set, else system default. */
  format: DateFormat;
  /** Whether the effective format came from the user override or the system default. */
  source: "user" | "system";
  /** User's explicit preference, or null if they're inheriting the system default. */
  userFormat: DateFormat | null;
  systemFormat: DateFormat;
  /** True while the initial fetch from /api/auth/me is in flight. */
  loading: boolean;
  formatDate: (value: Date | string | number | null | undefined) => string;
  formatDateTime: (value: Date | string | number | null | undefined) => string;
  /** Patch state after a successful PUT to /api/account/preferences or /api/admin/system-settings. */
  setUserFormat: (value: DateFormat | null) => void;
  setSystemFormat: (value: DateFormat) => void;
}

const DateFormatContext = createContext<DateFormatContextValue>({
  format: DEFAULT_DATE_FORMAT,
  source: "system",
  userFormat: null,
  systemFormat: DEFAULT_DATE_FORMAT,
  loading: true,
  formatDate: (v) => formatDateWith(v, DEFAULT_DATE_FORMAT),
  formatDateTime: (v) => formatDateTimeWith(v, DEFAULT_DATE_FORMAT),
  setUserFormat: () => {},
  setSystemFormat: () => {},
});

export function useDateFormat() {
  return useContext(DateFormatContext);
}

export default function DateFormatProvider({ children }: { children: ReactNode }) {
  const [userFormat, setUserFormatState] = useState<DateFormat | null>(null);
  const [systemFormat, setSystemFormatState] = useState<DateFormat>(DEFAULT_DATE_FORMAT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Shared with AuthProvider's mount fetch, so a page load hits /api/auth/me once.
      const data = await fetchMe();
      if (cancelled) return;
      if (data) {
        if (isDateFormat(data.systemDateFormat)) setSystemFormatState(data.systemDateFormat);
        if (data.dateFormat === null || data.dateFormat === undefined) {
          setUserFormatState(null);
        } else if (isDateFormat(data.dateFormat)) {
          setUserFormatState(data.dateFormat);
        }
      }
      // On failure/unauthenticated, leave defaults in place.
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const format = userFormat ?? systemFormat;
  const source: "user" | "system" = userFormat ? "user" : "system";

  const formatDate = useCallback(
    (value: Date | string | number | null | undefined) => formatDateWith(value, format),
    [format]
  );
  const formatDateTime = useCallback(
    (value: Date | string | number | null | undefined) => formatDateTimeWith(value, format),
    [format]
  );

  const setUserFormat = useCallback((value: DateFormat | null) => setUserFormatState(value), []);
  const setSystemFormat = useCallback((value: DateFormat) => setSystemFormatState(value), []);

  const value = useMemo<DateFormatContextValue>(
    () => ({
      format,
      source,
      userFormat,
      systemFormat,
      loading,
      formatDate,
      formatDateTime,
      setUserFormat,
      setSystemFormat,
    }),
    [format, source, userFormat, systemFormat, loading, formatDate, formatDateTime, setUserFormat, setSystemFormat]
  );

  return <DateFormatContext.Provider value={value}>{children}</DateFormatContext.Provider>;
}
