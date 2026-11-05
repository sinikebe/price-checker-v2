import { createContext, useContext } from "react";
import type { BasketFilters } from "./v2-basket-comparison";
import { EMPTY_SITE_FILTER, type SiteFilter } from "./v2-site-filter";

export type SiteFilterValue = {
  /** The account's saved filter (on this device). */
  filter: SiteFilter;
  /** The filters in force across the site, or null when the site filter is off. */
  active: BasketFilters | null;
  /** Saves the filter on this device; only a signed-in account has one. */
  save: (filter: SiteFilter) => void;
  signedIn: boolean;
};

export const SiteFilterContext = createContext<SiteFilterValue>({ filter: EMPTY_SITE_FILTER, active: null, save: () => undefined, signedIn: false });

/** The site-wide store filter in force on this page. */
export const useSiteFilter = () => useContext(SiteFilterContext);
