import { useEffect, useState } from "react";
import { readCredits, type BasketCredits } from "./v2-basket-credits-api";

/** The reader's credits (and what contributions earn), read once per page; null while unknown. */
export function useCredits(userId: number | null): BasketCredits | null {
  const [state, setState] = useState<{ userId: number | null; credits: BasketCredits | null }>({ userId, credits: null });
  useEffect(() => {
    const controller = new AbortController();
    readCredits(controller.signal)
      .then(credits => { if (!controller.signal.aborted) setState({ userId, credits }); })
      .catch(() => { /* no hint without the amounts */ });
    return () => controller.abort();
  }, [userId]);
  return state.userId === userId ? state.credits : null;
}
