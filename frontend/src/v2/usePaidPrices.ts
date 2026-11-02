import { useCallback, useEffect, useRef, useState } from "react";
import { CostChangedError, NoCreditsError, creditLabel, paidFetch, readCredits, shortText, type BasketCredits } from "./v2-basket-credits-api";
import { readPaid, viewerKey, writePaid, type PaidKind } from "./v2-price-cache";

export type PaidPrices<T> = {
  data: T | null; fetchedAt: string | null; credits: BasketCredits | null; cost: number;
  busy: boolean; error: string; newer: boolean; pay: (maxCost?: number) => Promise<void>; markNewer: () => void;
};

/**
 * Prices that cost credits: shown from this browser when already paid for, fetched only on request
 * (`pay`), or by themselves for an administrator, who is not counted. `url(cost)` builds the request
 * that spends at most `cost` credits.
 */
export function usePaidPrices<T>(userId: number | null, kind: PaidKind, id: string | null, announced: number, url: (cost: number) => string): PaidPrices<T> {
  const viewer = viewerKey(userId);
  const [state, setState] = useState<{ key: string; data: T | null; fetchedAt: string | null }>({ key: "", data: null, fetchedAt: null });
  const [credits, setCredits] = useState<BasketCredits | null>(null);
  // The server may say the page now costs more than announced: kept for this page only.
  const [override, setOverride] = useState<{ key: string; cost: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newer, setNewer] = useState(false);
  const key = id === null ? "" : `${viewer}:${kind}:${id}`;
  const cost = override && override.key === key ? override.cost : announced;
  const urlRef = useRef(url);
  useEffect(() => { urlRef.current = url; }, [url]);

  const pay = useCallback(async (maxCost: number = cost) => {
    if (id === null) return;
    setBusy(true); setError("");
    try {
      const answer = await paidFetch<T>(urlRef.current(maxCost));
      const fetchedAt = new Date().toISOString();
      writePaid(viewer, kind, id, answer);
      setState({ key, data: answer, fetchedAt });
      setCredits(answer.credits);
      setNewer(false);
    } catch (reason) {
      if (reason instanceof NoCreditsError) { setCredits(reason.credits); setError(shortText(reason.credits, reason.cost)); }
      else if (reason instanceof CostChangedError) { setOverride({ key, cost: reason.cost }); setError(`Le nombre de prix a changé : cette page coûte maintenant ${creditLabel(reason.cost)}. Rien n’a été dépensé.`); }
      else setError(reason instanceof Error && reason.message ? reason.message : "Impossible de récupérer les prix. Aucun crédit n’a été dépensé.");
    } finally { setBusy(false); }
  }, [id, viewer, kind, key, cost]);

  useEffect(() => {
    if (id === null) return;
    const cached = readPaid<T>(viewer, kind, id);
    setState({ key, data: cached?.data ?? null, fetchedAt: cached?.fetchedAt ?? null });
    setError(""); setNewer(false);
    const controller = new AbortController();
    readCredits(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setCredits(value);
      if (value.unlimited) void pay(announced);
    }).catch(() => { /* unknown balance: the server still decides */ });
    return () => controller.abort();
    // `pay` changes with the cost; a new page (key) is what reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = state.key === key;
  return {
    data: current ? state.data : null, fetchedAt: current ? state.fetchedAt : null, credits, cost, busy, error, newer, pay,
    markNewer: () => { if (credits?.unlimited) void pay(); else setNewer(true); },
  };
}
