import { useCallback, useEffect, useRef, useState } from "react";
import type { V2User } from "./v2-auth-api";
import { readBasketDefaultStores } from "./v2-basket-default-stores";
import {
  abortText, detectExtension, planProblem, readingBody, recordReading, requestPlan, runJob,
  nothingToReadText, type ExtensionInfo, type Plan,
} from "./v2-extension-bridge";

export type ExtensionRefresh =
  | { phase: "idle" }
  | { phase: "reading"; done: number; total: number; store: string; needsHuman: boolean }
  | { phase: "done"; saved: number; message: string }
  | { phase: "stopped"; message: string };

/**
 * Read, with the administrator's extension, the prices the server plans for some products: after the basket's
 * prices are fetched (silent when there is nothing to read), or on a click on one product (`announce`: say so).
 */
export function useExtensionRefresh(user: V2User | null) {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);
  const [state, setState] = useState<ExtensionRefresh>({ phase: "idle" });
  const busy = useRef(false);
  const admin = user?.role === "admin";

  useEffect(() => {
    if (!admin) { setInfo(null); return; }
    let active = true;
    void detectExtension().then(value => { if (active) setInfo(value && value.adapters.includes("carrefour") ? value : null); });
    return () => { active = false; };
  }, [admin, user?.id]);

  const start = useCallback(async (productIds: number[], finished: (saved: number) => void, options?: { announce?: boolean }) => {
    if (!info || busy.current || !productIds.length) return;
    busy.current = true;
    let saved = 0;
    try {
      let plan: Plan;
      try { plan = await requestPlan(productIds, readBasketDefaultStores().map(store => store.id)); } catch {
        if (options?.announce) setState({ phase: "stopped", message: "Extension : le serveur n’a pas pu préparer la lecture." });
        return;
      }
      if (!plan.store) { setState({ phase: "stopped", message: "Extension : " + planProblem(plan.reason) }); return; }
      const store = plan.store.name;
      if (!plan.items.length) {
        if (options?.announce) setState({ phase: "done", saved: 0, message: "Extension : " + nothingToReadText(store) });
        return;
      }
      setState({ phase: "reading", done: 0, total: plan.items.length, store, needsHuman: false });
      let aborted: string | null = null;
      const job = runJob(plan, event => {
        if (event.type === "progress") {
          setState({ phase: "reading", done: event.done, total: event.total, store, needsHuman: false });
          const body = readingBody(plan, event.item);
          if (body) void recordReading(body).then(result => { if (result.saved) saved += 1; }).catch(() => undefined);
        } else if (event.type === "needs-human") setState(current => current.phase === "reading" ? { ...current, needsHuman: true } : current);
        else if (event.type === "resumed") setState(current => current.phase === "reading" ? { ...current, needsHuman: false } : current);
        else if (event.type === "aborted") aborted = abortText(event.reason, plan, event.store);
      });
      await job.finished;
      await new Promise(resolve => window.setTimeout(resolve, 600)); // the last reading's answer
      if (aborted) setState({ phase: "stopped", message: "Extension : " + aborted });
      else setState({ phase: "done", saved, message: saved ? `Extension : ${saved} prix mis à jour à ${store}.` : `Extension : aucun nouveau prix à ${store}.` });
      if (saved) finished(saved);
    } finally { busy.current = false; }
  }, [info]);

  return { available: !!info, state, start };
}
