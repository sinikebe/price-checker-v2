import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SharedBasketError, changeSharedBasket, createSharedBasket, deleteSharedBasket, joinSharedBasket,
  listSharedBaskets, readSharedBasket, removeSharedMember, renameSharedBasket, renewSharedInvite, waitSharedBasket,
} from "./v2-shared-basket-api";
import {
  MAX_OPS, activityText, allowedOffline, applyOps, applySettings, diffOps, forgetSharedCache, newFromOthers, queueOps, readSharedCache, readSharedId,
  sharedItems, sharedLookedKey, sharedSettings, tickOps, wireOps, writeSharedId, writeSharedQueue, writeSharedState, type LocalOp, type SharedBasket, type SharedLine, type SharedSettings,
} from "./v2-shared-basket";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import { errorText } from "./v2-http";

export type SharedStatus = "connecting" | "live" | "retrying" | "offline";
const GONE = "Ce panier partagé n’est plus accessible : il a été supprimé ou vous en avez été retiré. Vous retrouvez votre panier.";
// The same empty lists on every render before the basket loads, so the memos built on them hold.
const NO_LINES: SharedLine[] = [];
const NO_UNAVAILABLE: SharedLine[] = [];

// Each wait removes every listener it added when it ends, so a long poll leaves none behind on the
// effect's signal; a signal already aborted ends it at once.
/** Wait `ms`, or less when the page is closed or the connection comes back. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); window.removeEventListener("online", done); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done, { once: true });
    signal.addEventListener("abort", done, { once: true });
  });
}
/** Wait until the page is shown again, or closed. */
function visible(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => {
      if (!document.hidden || signal.aborted) { document.removeEventListener("visibilitychange", done); signal.removeEventListener("abort", done); resolve(); }
    };
    document.addEventListener("visibilitychange", done);
    signal.addEventListener("abort", done, { once: true });
  });
}
const message = (error: unknown) => errorText(error, "Le panier partagé ne répond pas. Réessayez.");

/**
 * The shared basket this account has open in this browser, kept live: a read waits on the server
 * for the next change, edits show at once and are sent in order. Nothing runs while no shared
 * basket is open, and reading pauses while the page is hidden. Its last state, the moment the server
 * last confirmed it and the changes not sent yet are kept in the browser: it opens offline, read
 * only except the ticks of its list, which leave as soon as the connection is back.
 */
export function useSharedBasket(userId: number | null) {
  const [owner, setOwner] = useState(userId);
  const [sharedId, setSharedId] = useState(() => readSharedId(userId));
  // What the browser kept for this basket, applied to the refs below by an effect.
  const [loaded, setLoaded] = useState(() => readSharedCache(sharedId, userId));
  const [basket, setBasket] = useState<SharedBasket | null>(loaded.basket);
  const [syncedAt, setSyncedAt] = useState<string | null>(loaded.basket?.synced_at ?? null);
  const [live, setLive] = useState(true);
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activity, setActivity] = useState("");
  // The changes not confirmed yet (in flight, then queued), mirrored from the refs for rendering.
  const [pending, setPending] = useState<LocalOp[]>(loaded.queue);
  if (owner !== userId) {
    const id = readSharedId(userId), cache = readSharedCache(id, userId);
    setOwner(userId); setSharedId(id); setLoaded(cache); setBasket(cache.basket); setSyncedAt(cache.basket?.synced_at ?? null); setPending(cache.queue); setError(""); setActivity("");
  }
  const basketRef = useRef<SharedBasket | null>(null);
  const queue = useRef<LocalOp[]>([]);
  const inflight = useRef<LocalOp[]>([]);
  const sending = useRef(false);
  const idRef = useRef(sharedId);
  useEffect(() => { idRef.current = sharedId; }, [sharedId]);
  useEffect(() => { basketRef.current = loaded.basket; queue.current = [...loaded.queue]; inflight.current = []; }, [loaded]);
  /** Mirror the unconfirmed changes for rendering, and keep them in the browser until they are sent. */
  const sync = useCallback(() => {
    const ops = [...inflight.current, ...queue.current];
    setPending(ops);
    if (userId && idRef.current) writeSharedQueue(idRef.current, userId, ops);
  }, [userId]);
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
    const now = new Date().toISOString();
    basketRef.current = next; setBasket(next); setOffline(false); setSyncedAt(now);
    if (userId) writeSharedState(userId, next, now);
  }, [userId]);
  /** The server said nothing changed: the copy kept here is up to date as of now. */
  const confirmed = useCallback(() => {
    const now = new Date().toISOString(), current = basketRef.current;
    setSyncedAt(now);
    if (userId && current) writeSharedState(userId, current, now);
  }, [userId]);
  /** Switch to another basket (or none), starting from what the browser kept for it. */
  const load = useCallback((id: number | null) => {
    const cache = readSharedCache(id, userId);
    basketRef.current = cache.basket; queue.current = [...cache.queue]; inflight.current = []; idRef.current = id;
    setLoaded(cache); setBasket(cache.basket); setSyncedAt(cache.basket?.synced_at ?? null); setPending(cache.queue); setSharedId(id);
  }, [userId]);
  const forget = useCallback((text: string) => {
    if (userId) { writeSharedId(userId, null); if (idRef.current) forgetSharedCache(idRef.current, userId); }
    load(null); setActivity(""); setNotice(text);
  }, [userId, load]);

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
            else confirmed();
          }
          failures = 0; setLive(true);
          // Back online after changes made offline: send them now.
          if (queue.current.length && !sending.current) void flushRef.current();
        } catch (reason) {
          if (signal.aborted) return;
          if (reason instanceof SharedBasketError && reason.status === 401) {
            // Signed out: keep the basket for after the next sign-in, stop reading meanwhile.
            setLive(false); setError("Votre session a expiré : reconnectez-vous pour suivre le panier partagé."); return;
          }
          if (reason instanceof SharedBasketError && [403, 404].includes(reason.status)) { forget(GONE); return; }
          failures += 1; setLive(false);
          if (!(reason instanceof SharedBasketError)) setOffline(true);
          await pause(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), signal);
        }
      }
    })();
    return () => controller.abort();
  }, [sharedId, accept, confirmed, forget]);

  // A shared basket created or joined on another device is found once per session, so its dock
  // entry shows here too.
  useEffect(() => {
    if (!userId || sharedId) return;
    const flag = sharedLookedKey(userId);
    try { if (sessionStorage.getItem(flag)) return; sessionStorage.setItem(flag, "1"); } catch { return; }
    let active = true;
    listSharedBaskets().then(result => {
      const latest = result.baskets[0];
      if (active && latest && !readSharedId(userId)) { writeSharedId(userId, latest.id); load(latest.id); }
    }).catch(() => { /* the list stays reachable from the basket page */ });
    return () => { active = false; };
  }, [userId, sharedId, load]);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length && idRef.current) {
        // Offline: the changes wait in the browser, and leave when the connection is back.
        if (!navigator.onLine) { setOffline(true); break; }
        const id = idRef.current;
        inflight.current = queue.current.splice(0, MAX_OPS); sync();
        try {
          const next = await changeSharedBasket(id, wireOps(inflight.current));
          inflight.current = []; accept(next); setError("");
        } catch (reason) {
          if (reason instanceof SharedBasketError && reason.status === 404) { forget(GONE); return; }
          if (!(reason instanceof SharedBasketError) || reason.status === 401 || reason.status === 429 || reason.status >= 500) {
            // No answer, signed out, or not now: keep the changes, in order, for the next try.
            queue.current = [...inflight.current, ...queue.current]; inflight.current = [];
            if (!(reason instanceof SharedBasketError)) setOffline(true);
            else setError(reason.status === 401 ? "Votre session a expiré : reconnectez-vous, vos modifications seront envoyées ensuite." : message(reason));
            break;
          }
          // Refused: the server state wins and the change disappears from the screen.
          inflight.current = [];
          setError(message(reason) + " La modification n’a pas été enregistrée.");
        } finally { sync(); }
      }
    } finally { sending.current = false; }
  }, [accept, forget, sync]);
  const flushRef = useRef(flush);
  useEffect(() => { flushRef.current = flush; }, [flush]);
  useEffect(() => {
    const back = () => { setOffline(false); void flushRef.current(); };
    const gone = () => setOffline(true);
    window.addEventListener("online", back); window.addEventListener("offline", gone);
    return () => { window.removeEventListener("online", back); window.removeEventListener("offline", gone); };
  }, []);

  const current = basket?.id === sharedId ? basket : null;
  const base = useMemo(() => current ? sharedItems(current.lines) : null, [current]);
  const items = useMemo(() => applyOps(base?.items ?? [], pending, basketItemKey), [base, pending]);
  const settings = useMemo(() => applySettings(sharedSettings(current), pending), [current, pending]);
  const lineByKey = useMemo(() => new Map((base?.items ?? []).map((item, index) => [basketItemKey(item), base!.lines[index]])), [base]);

  /** Show changes now and send them; offline, only ticks are taken (the screen offers nothing else). */
  const send = useCallback((ops: LocalOp[]) => {
    const taken = navigator.onLine ? ops : ops.filter(allowedOffline);
    if (taken.length < ops.length) setError("Hors connexion : seules les coches de la liste peuvent changer. Réessayez au retour de la connexion.");
    if (!taken.length) return;
    queue.current = queueOps(queue.current, taken); sync();
    void flush();
  }, [flush, sync]);
  /** Turn the basket into `next`: the difference is shown now and sent to the server. */
  const edit = useCallback((next: BasketItem[]) => {
    const ops = diffOps(view(), next, basketItemKey);
    if (ops.length) send(ops);
  }, [send, view]);
  /** Change settings every member sees (filters, quantities, price or unit price, stores off, units). */
  const setSettings = useCallback((patch: Partial<SharedSettings>) => send([{ op: "settings", patch }]), [send]);
  /** Tick the list: one change per article, so ticks made elsewhere meanwhile are kept. Works offline. */
  const setChecked = useCallback((next: string[]) => {
    const known = basketRef.current?.id === idRef.current ? basketRef.current : null;
    const now = applySettings(sharedSettings(known), [...inflight.current, ...queue.current]).checked;
    const ops = tickOps(now, next);
    if (ops.length) send(ops);
  }, [send]);

  const open = useCallback((id: number | null) => {
    if (!userId) return;
    if (id === null && idRef.current) forgetSharedCache(idRef.current, userId);
    writeSharedId(userId, id);
    load(id); setError(""); setNotice(""); setActivity(""); setLive(true);
  }, [userId, load]);
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
    sharedId, basket: current, items, view, settings, setSettings, setChecked, lines: base?.lines ?? NO_LINES, unavailable: base?.unavailable ?? NO_UNAVAILABLE,
    /** When the server last confirmed the basket shown (ISO date), kept for offline use. */
    syncedAt,
    status: (offline ? "offline" : !current ? "connecting" : live ? "live" : "retrying") as SharedStatus,
    /** Changes kept in the browser, not confirmed by the server yet. */
    waiting: pending.length,
    error, notice, activity, edit, open,
    clearNotice: () => setNotice(""),
    /** Who added this line, for the shared basket's article list ("vous" for this account). */
    addedBy(item: BasketItem): string | null {
      const line = lineByKey.get(basketItemKey(item));
      return line ? line.mine ? "vous" : line.added_by ?? "un ancien membre" : null;
    },
    /** Remove a product line that can no longer be shown (withdrawn from the catalogue since). */
    dropUnavailable(productId: number) {
      send([{ op: "remove", line: { kind: "product", product_id: productId }, key: "product:" + productId }]);
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
