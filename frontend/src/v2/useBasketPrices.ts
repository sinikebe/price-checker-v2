import { useCallback, useEffect, useRef, useState } from "react";
import { requestBasketConnectorRefresh } from "./v2-connector-refresh";
import {
  NoCreditsError, SignedOutError, balanceText, fetchBasketPrices, readBasketCredits, shortText, spendable,
  type BasketCredits,
} from "./v2-basket-credits-api";
import { readSnapshot, snapshotFromFetch, writeSnapshot, type BasketSnapshot } from "./v2-basket-snapshot";
import type { BasketItem } from "./v2-basket-storage";

export const MAX_FETCHED_ITEMS = 100;
export type PriceFetch =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string; signedOut?: boolean };

/** The lines sent for prices: the included ones, at most MAX_FETCHED_ITEMS. One credit each. */
export function fetchedItems<T extends BasketItem>(items: readonly T[]): T[] {
  return items.filter(item => !item.disabled).slice(0, MAX_FETCHED_ITEMS);
}
/** What fetching the prices of this basket costs: one credit per included line. */
export const basketFetchCost = (items: readonly BasketItem[]) => fetchedItems(items).length;

/** The prices of a basket are fetched on request only, for one credit per line; the last result is kept. */
export function useBasketPrices(userId: number | null, items: readonly BasketItem[], afterFetch?: (productIds: number[]) => void, basketId?: number) {
  const scope = `${userId ?? ""}:${basketId ?? ""}`;
  const [owner, setOwner] = useState(scope);
  const [snapshot, setSnapshot] = useState<BasketSnapshot | null>(() => userId ? readSnapshot(userId, basketId) : null);
  const [credits, setCredits] = useState<BasketCredits | null>(null);
  const [state, setState] = useState<PriceFetch>({ phase: "idle" });
  if (owner !== scope) {
    setOwner(scope);
    setSnapshot(userId ? readSnapshot(userId, basketId) : null);
    if (owner.split(":")[0] !== String(userId ?? "")) setCredits(null);
    setState({ phase: "idle" });
  }
  // A result that arrives after the account or the basket changed is stored, but not shown.
  const current = useRef(scope);
  useEffect(() => { current.current = scope; }, [scope]);
  const busy = useRef(false);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    readBasketCredits(controller.signal)
      .then(value => { if (!controller.signal.aborted) setCredits(value); })
      .catch(() => { /* unknown balance: the server still decides */ });
    return () => controller.abort();
  }, [userId]);

  const fetchPrices = useCallback(async (quiet = false) => {
    if (!userId || busy.current || !fetchedItems(items).length) return;
    if (!navigator.onLine) {
      setState({ phase: "error", message: "Hors ligne : les prix ne peuvent pas être récupérés. Aucun crédit n’a été dépensé." });
      return;
    }
    busy.current = true;
    setState({ phase: "loading" });
    const sent = fetchedItems(items);
    try {
      const result = await fetchBasketPrices(sent);
      const next = snapshotFromFetch(userId, sent, result, basketId);
      writeSnapshot(next);
      if (current.current !== scope) return;
      setSnapshot(next);
      setCredits(result.credits);
      setState({ phase: "done", message: "Prix récupérés. " + (result.credits.unlimited ? "Crédits illimités."
        : spendable(result.credits) ? balanceText(result.credits) + "." : "Plus de crédit aujourd’hui.") });
      const concrete = sent.flatMap((item, index) => "kind" in item ? [] : result.lines[index].product_ids);
      if (concrete.length && !quiet) {
        void requestBasketConnectorRefresh(concrete);
        afterFetch?.(concrete);
      }
    } catch (error) {
      if (current.current !== scope) return;
      if (error instanceof NoCreditsError) {
        setCredits(error.credits);
        setState({ phase: "error", message: shortText(error.credits, error.cost) });
      } else if (error instanceof SignedOutError) {
        setState({ phase: "error", signedOut: true, message: "Votre session a expiré. Reconnectez-vous pour récupérer les prix." });
      } else {
        setState({ phase: "error", message: error instanceof Error && error.message ? error.message : "Impossible de récupérer les prix. Aucun crédit n’a été dépensé." });
        readBasketCredits().then(value => { if (current.current === scope) setCredits(value); }).catch(() => { /* keep the last balance */ });
      }
    } finally { busy.current = false; }
  }, [userId, items, afterFetch, basketId, scope]);

  return { snapshot, credits, state, fetchPrices };
}
