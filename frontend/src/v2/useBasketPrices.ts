import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestBasketConnectorRefresh } from "./v2-connector-refresh";
import {
  NoCreditsError, SignedOutError, balanceText, fetchBasketPrices, readBasketCredits, shortText, spendable,
  type BasketCredits,
} from "./v2-basket-credits-api";
import { readSnapshot, snapshotFromFetch, writeSnapshot, type BasketSnapshot } from "./v2-basket-snapshot";
import { basketItemKey, isPriceable, type BasketItem } from "./v2-basket-storage";
import { fetchSharedBasketPrices, readSharedBasketPrices } from "./v2-shared-basket-api";
import { readSharedPrices, sharedSnapshot, writeSharedPrices, type SharedLine, type SharedPrices } from "./v2-shared-basket";

export const MAX_FETCHED_ITEMS = 100;
export type PriceFetch =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string; signedOut?: boolean };

/** The lines sent for prices: the included ones that have prices (not free text), at most MAX_FETCHED_ITEMS. One credit each. */
export function fetchedItems<T extends BasketItem>(items: readonly T[]): T[] {
  return items.filter(item => !item.disabled && isPriceable(item)).slice(0, MAX_FETCHED_ITEMS);
}
/** What fetching the prices of this basket costs: one credit per included line. */
export const basketFetchCost = (items: readonly BasketItem[]) => fetchedItems(items).length;

/** A shared basket: its prices are fetched once by a member, for every member. */
export type SharedPriceSource = { basketId: number; pricesAt: string | null; lines: readonly SharedLine[] };

/**
 * The prices of a basket are fetched on request only, for one credit per line; the last result is kept.
 * For a shared basket the result is the basket's: the member who fetches pays, every member sees it (and
 * keeps a copy for offline use), without spending credits.
 */
export function useBasketPrices(userId: number | null, items: readonly BasketItem[], afterFetch?: (productIds: number[]) => void, shared?: SharedPriceSource) {
  const basketId = shared?.basketId;
  const scope = `${userId ?? ""}:${basketId ?? ""}`;
  const [owner, setOwner] = useState(scope);
  const [snapshot, setSnapshot] = useState<BasketSnapshot | null>(() => userId && !basketId ? readSnapshot(userId) : null);
  const [serverPrices, setServerPrices] = useState<SharedPrices | null>(() => userId && basketId ? readSharedPrices(basketId, userId) : null);
  const [credits, setCredits] = useState<BasketCredits | null>(null);
  const [state, setState] = useState<PriceFetch>({ phase: "idle" });
  if (owner !== scope) {
    setOwner(scope);
    setSnapshot(userId && !basketId ? readSnapshot(userId) : null);
    setServerPrices(userId && basketId ? readSharedPrices(basketId, userId) : null);
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

  // Another member fetched newer prices: read them, free of charge.
  const pricesAt = shared?.pricesAt ?? null;
  const known = serverPrices?.fetched_at ?? null;
  useEffect(() => {
    if (!userId || !basketId || !pricesAt || pricesAt === known || !navigator.onLine) return;
    const controller = new AbortController();
    readSharedBasketPrices(basketId, controller.signal).then(result => {
      if (controller.signal.aborted || !result.prices) return;
      writeSharedPrices(basketId, userId, result.prices);
      setServerPrices(result.prices);
    }).catch(() => { /* the copy kept here stays shown */ });
    return () => controller.abort();
  }, [userId, basketId, pricesAt, known]);

  const lines = shared?.lines;
  const sharedResult = useMemo(() => serverPrices && lines && userId && basketId
    ? sharedSnapshot(serverPrices, lines, basketItemKey, { userId, basketId }) : null, [serverPrices, lines, userId, basketId]);

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
      let concrete: number[];
      let paid: BasketCredits;
      if (basketId) {
        const result = await fetchSharedBasketPrices(basketId, sent.length);
        writeSharedPrices(basketId, userId, result.prices);
        if (current.current !== scope) return;
        setServerPrices(result.prices);
        paid = result.credits;
        const { lines: fetched, line_ids: ids } = result.prices.content;
        const productLines = new Set((lines ?? []).filter(line => line.kind === "product").map(line => line.id));
        concrete = fetched.flatMap((line, index) => productLines.has(ids[index]) ? line.product_ids : []);
      } else {
        const result = await fetchBasketPrices(sent);
        const next = snapshotFromFetch(userId, sent, result);
        writeSnapshot(next);
        if (current.current !== scope) return;
        setSnapshot(next);
        paid = result.credits;
        concrete = sent.flatMap((item, index) => "kind" in item ? [] : result.lines[index].product_ids);
      }
      setCredits(paid);
      const everyone = basketId ? " Tous les membres du panier partagé les voient." : "";
      setState({ phase: "done", message: "Prix récupérés." + everyone + " " + (paid.unlimited ? "Crédits illimités."
        : spendable(paid) ? balanceText(paid) + "." : "Plus de crédit aujourd’hui.") });
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
  }, [userId, items, afterFetch, basketId, scope, lines]);

  return {
    snapshot: basketId ? sharedResult : snapshot, credits, state, fetchPrices,
    /** Who fetched the shared basket's prices (a member's name), when known. */
    fetchedBy: basketId ? serverPrices?.fetched_by ?? null : null,
  };
}
