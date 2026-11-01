import { useEffect, useRef, useState } from "react";
import { RateLimitedError, type SuggestResult } from "./v2-catalogue-api";
import {
  SEARCH_DEBOUNCE_MS, normalizeQuery, remember, resolveView,
  type CompleteList, type SearchOutcome, type SearchScope, type SearchView, type SearchableProduct,
} from "./v2-catalogue-search";

export type Suggest<T> = (query: string, scope: SearchScope, signal: AbortSignal) => Promise<SuggestResult<T>>;

/**
 * Search as you type. A request is made only when no list already held can answer: after a pause in the
 * typing, and never faster than the server allows. Every other keystroke is answered by filtering a list.
 */
export function useCatalogueSearch<T extends SearchableProduct>(query: string, scope: SearchScope, suggest: Suggest<T>): SearchView<T> {
  const [cache, setCache] = useState<CompleteList<T>[]>([]);
  const [outcome, setOutcome] = useState<{ key: string; value: SearchOutcome } | null>(null);
  const [limitedFor, setLimitedFor] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(suggest);
  useEffect(() => { latest.current = suggest; });
  const retryTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  const wanted = normalizeQuery(query);
  const { category, storeId } = scope;
  const key = `${wanted}|${category.trim().toLocaleLowerCase("fr")}|${storeId}|${attempt}`;
  const view = resolveView({ query: wanted, scope, cache, outcome: outcome?.key === key ? outcome.value : null, limitedFor });
  const due = view.kind === "loading";

  useEffect(() => {
    if (!due) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await latest.current(wanted, { category, storeId }, controller.signal);
        if (controller.signal.aborted) return;
        if (result.complete) setCache(current => remember(current, { query: wanted, scope: { category, storeId }, items: result.items }));
        else setOutcome({ key, value: { kind: "many", total: result.total, max: result.max } });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RateLimitedError) {
          setLimitedFor(error.retryAfter);
          retryTimer.current = window.setTimeout(() => { setLimitedFor(null); setAttempt(count => count + 1); }, error.retryAfter * 1000);
        } else setOutcome({ key, value: { kind: "error", message: error instanceof Error ? error.message : "La recherche a échoué." } });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [due, key, wanted, category, storeId]);

  return view;
}
