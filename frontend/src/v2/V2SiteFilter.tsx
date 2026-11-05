import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SiteFilterContext } from "./useSiteFilter";
import { activeSiteFilters, readSiteFilter, siteFilterKey, writeSiteFilter, type SiteFilter } from "./v2-site-filter";

function storage() {
  try { return window.localStorage; } catch { return null; }
}

/** The signed-in account's site-wide store filter, as saved on this device; other tabs follow a change. */
export function V2SiteFilterProvider({ userId, children }: { userId: number | null; children: ReactNode }) {
  const [state, setState] = useState(() => ({ userId, filter: readSiteFilter(storage(), userId) }));
  const filter = state.userId === userId ? state.filter : readSiteFilter(storage(), userId);
  useEffect(() => {
    if (!userId) return;
    const changed = (event: StorageEvent) => {
      if (event.key === siteFilterKey(userId)) setState({ userId, filter: readSiteFilter(storage(), userId) });
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [userId]);
  const save = useCallback((next: SiteFilter) => {
    const kept = storage();
    if (!userId || !kept) throw new Error("Connectez-vous pour enregistrer un filtre.");
    setState({ userId, filter: writeSiteFilter(kept, userId, next) });
  }, [userId]);
  const value = useMemo(() => ({ filter, active: userId ? activeSiteFilters(filter) : null, save, signedIn: userId !== null }), [filter, userId, save]);
  return <SiteFilterContext.Provider value={value}>{children}</SiteFilterContext.Provider>;
}
