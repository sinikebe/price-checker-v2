import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SharedBasketError, changeSharedBasket, createSharedBasket, deleteSharedBasket, joinSharedBasket,
  listSharedBaskets, readSharedBasket, removeSharedMember, renameSharedBasket, renewSharedInvite, waitSharedBasket,
} from "./v2-shared-basket-api";
import {
  MAX_OPS, activityText, applyOps, applySettings, diffOps, newFromOthers, queueOps, readSharedId, sharedItems,
  sharedSettings, wireOps, writeSharedId, type LocalOp, type SharedBasket, type SharedSettings,
} from "./v2-shared-basket";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";

export type SharedStatus = "connecting" | "live" | "retrying";
const GONE = "Ce panier partagé n’est plus accessible : il a été supprimé ou vous en avez été retiré. Vous retrouvez votre panier.";

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
function visible(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { if (!document.hidden || signal.aborted) { document.removeEventListener("visibilitychange", done); resolve(); } };
    document.addEventListener("visibilitychange", done);
    signal.addEventListener("abort", done, { once: true });
  });
}
const message = (error: unknown) => error instanceof Error && error.message ? error.message : "Le panier partagé ne répond pas. Réessayez.";

/**
 * The shared basket this account has open in this browser, kept live: a read waits on the server
 * for the next change, edits show at once and are sent in order. Nothing runs while no shared
 * basket is open, and reading pauses while the page is hidden.
 */
export function useSharedBasket(userId: number | null) {
  const [owner, setOwner] = useState(userId);
  const [sharedId, setSharedId] = useState(() => readSharedId(userId));
  const [basket, setBasket] = useState<SharedBasket | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activity, setActivity] = useState("");
  // The changes not confirmed yet (in flight, then queued), mirrored from the refs for rendering.
  const [pending, setPending] = useState<LocalOp[]>([]);
  if (owner !== userId) {
    setOwner(userId); setSharedId(readSharedId(userId)); setBasket(null); setError(""); setActivity("");
  }
  const basketRef = useRef<SharedBasket | null>(null);
  const queue = useRef<LocalOp[]>([]);
  const inflight = useRef<LocalOp[]>([]);
  const sending = useRef(false);
  const idRef = useRef(sharedId);
  useEffect(() => { idRef.current = sharedId; }, [sharedId]);
  const sync = useCallback(() => setPending([...inflight.current, ...queue.current]), []);
  /** What the member sees now: the server's lines with the unconfirmed changes applied. */
  const view = useCallback(() => {
    const known = basketRef.current?.id === idRef.current ? basketRef.current : null;
    return applyOps(known ? sharedItems(known.lines).items : [], [...inflight.current, ...queue.current], basketItemKey);
  }, []);

  const accept = useCallback((next: SharedBasket) => {
    const current = basketRef.current?.id === next.id ? basketRef.current : null;
    if (current && next.revision < current.revision) return;
    const fresh = newFromOthers(current?.lines ?? null, next.lines);
    if (fresh.length) setActivity(activityText(fresh));
    basketRef.current = next; setBasket(next);
  }, []);
  const forget = useCallback((text: string) => {
    if (userId) writeSharedId(userId, null);
    queue.current = []; inflight.current = []; basketRef.current = null; idRef.current = null;
    setPending([]); setSharedId(null); setBasket(null); setActivity(""); setNotice(text);
  }, [userId]);

  useEffect(() => {
    if (!sharedId) return;
    const controller = new AbortController(), signal = controller.signal;
    let failures = 0;
    void (async () => {
      while (!signal.aborted) {
        try {
          if (document.hidden) { await visible(signal); continue; }
          const current = basketRef.current?.id === sharedId ? basketRef.current : null;
          if (!current) accept(await readSharedBasket(sharedId, signal));
          else {
            const { basket: next, retryAfter } = await waitSharedBasket(sharedId, current.revision, signal);
            if (next) accept(next);
            else if (retryAfter) await pause(retryAfter * 1000, signal);
          }
          failures = 0; setLive(true);
        } catch (reason) {
          if (signal.aborted) return;
          if (reason instanceof SharedBasketError && reason.status === 401) {
            // Signed out: keep the basket for after the next sign-in, stop reading meanwhile.
            setLive(false); setError("Votre session a expiré : reconnectez-vous pour suivre le panier partagé."); return;
          }
          if (reason instanceof SharedBasketError && [403, 404].includes(reason.status)) { forget(GONE); return; }
          failures += 1; setLive(false);
          await pause(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), signal);
        }
      }
    })();
    return () => controller.abort();
  }, [sharedId, accept, forget]);

  // A shared basket created or joined on another device is found once per session, so its dock
  // entry shows here too.
  useEffect(() => {
    if (!userId || sharedId) return;
    const flag = `v2:basket:shared-looked:${userId}`;
    try { if (sessionStorage.getItem(flag)) return; sessionStorage.setItem(flag, "1"); } catch { return; }
    let active = true;
    listSharedBaskets().then(result => {
      const latest = result.baskets[0];
      if (active && latest && !readSharedId(userId)) { writeSharedId(userId, latest.id); setSharedId(latest.id); }
    }).catch(() => { /* the list stays reachable from the basket page */ });
    return () => { active = false; };
  }, [userId, sharedId]);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length && idRef.current) {
        const id = idRef.current;
        inflight.current = queue.current.splice(0, MAX_OPS); sync();
        try { accept(await changeSharedBasket(id, wireOps(inflight.current))); setError(""); }
        catch (reason) {
          if (reason instanceof SharedBasketError && reason.status === 404) { forget(GONE); return; }
          // The server state wins: the refused change disappears from the screen.
          setError(message(reason) + " La modification n’a pas été enregistrée.");
        } finally { inflight.current = []; sync(); }
      }
    } finally { sending.current = false; }
  }, [accept, forget, sync]);

  const current = basket?.id === sharedId ? basket : null;
  const base = useMemo(() => current ? sharedItems(current.lines) : null, [current]);
  const items = useMemo(() => applyOps(base?.items ?? [], pending, basketItemKey), [base, pending]);
  const settings = useMemo(() => applySettings(sharedSettings(current), pending), [current, pending]);
  const lineByKey = useMemo(() => new Map((base?.items ?? []).map((item, index) => [basketItemKey(item), base!.lines[index]])), [base]);

  /** Turn the basket into `next`: the difference is shown now and sent to the server. */
  const edit = useCallback((next: BasketItem[]) => {
    const ops = diffOps(view(), next, basketItemKey);
    if (!ops.length) return;
    queue.current = queueOps(queue.current, ops); sync();
    void flush();
  }, [flush, sync, view]);
  /** Change settings every member sees (filters, quantities, price or unit price, stores off, units). */
  const setSettings = useCallback((patch: Partial<SharedSettings>) => {
    queue.current = queueOps(queue.current, [{ op: "settings", patch }]); sync();
    void flush();
  }, [flush, sync]);

  const open = useCallback((id: number | null) => {
    if (!userId) return;
    writeSharedId(userId, id);
    queue.current = []; inflight.current = []; basketRef.current = null; idRef.current = id;
    setPending([]); setBasket(null); setSharedId(id); setError(""); setNotice(""); setActivity(""); setLive(true);
  }, [userId]);
  /** Run an action; a 404 about the open basket means it is gone (not so for creating or joining another). */
  const act = useCallback(async <T,>(action: () => Promise<T>, onOpenBasket = true): Promise<T | null> => {
    setError("");
    try { return await action(); }
    catch (reason) {
      if (onOpenBasket && reason instanceof SharedBasketError && reason.status === 404 && idRef.current) forget(GONE);
      else setError(message(reason));
      return null;
    }
  }, [forget]);

  return {
    sharedId, basket: current, items, view, settings, setSettings, lines: base?.lines ?? [], unavailable: base?.unavailable ?? [],
    status: (!current ? "connecting" : live ? "live" : "retrying") as SharedStatus,
    error, notice, activity, edit, open,
    clearNotice: () => setNotice(""),
    /** Who added this line, for the shared basket's article list ("vous" for this account). */
    addedBy(item: BasketItem): string | null {
      const line = lineByKey.get(basketItemKey(item));
      return line ? line.mine ? "vous" : line.added_by ?? "un ancien membre" : null;
    },
    /** Remove a product line that can no longer be shown (withdrawn from the catalogue since). */
    dropUnavailable(productId: number) {
      queue.current = queueOps(queue.current, [{ op: "remove", line: { kind: "product", product_id: productId }, key: "product:" + productId }]); sync();
      void flush();
    },
    async create(name: string, from: BasketItem[], startSettings?: Partial<SharedSettings>) {
      const created = await act(() => createSharedBasket(name, wireOps(diffOps([], from, basketItemKey)), startSettings), false);
      if (created) { open(created.id); accept(created); }
      return created;
    },
    async join(invite: string) {
      const joined = await act(() => joinSharedBasket(invite), false);
      if (joined) open(joined.id);
      return joined;
    },
    async rename(name: string) { if (current) { const next = await act(() => renameSharedBasket(current.id, name)); if (next) accept(next); return !!next; } return false; },
    async renewInvite() { if (current) { const next = await act(() => renewSharedInvite(current.id)); if (next) accept(next); } },
    async removeMember(memberId: number) {
      if (!current) return;
      const done = await act(async () => { await removeSharedMember(current.id, memberId); return true; });
      if (done) { const next = await act(() => readSharedBasket(current.id)); if (next) accept(next); }
    },
    async leave(selfId: number) {
      if (!current) return;
      const done = await act(async () => { await removeSharedMember(current.id, selfId); return true; });
      if (done) { open(null); setNotice("Vous avez quitté le panier partagé. Les articles que vous y aviez ajoutés y restent."); }
    },
    async remove() {
      if (!current) return;
      const done = await act(async () => { await deleteSharedBasket(current.id); return true; });
      if (done) { open(null); setNotice("Panier partagé supprimé pour tous ses membres."); }
    },
  };
}
export type SharedBasketControls = ReturnType<typeof useSharedBasket>;
