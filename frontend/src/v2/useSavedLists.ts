import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListError, deleteList, fetchLists, patchList, putList } from "./v2-saved-lists-api";
import {
  applyListOps, newListId, queueListOp, readLists, writeLists, writeListsQueue, type ListOp, type SavedList, type SavedListContent,
} from "./v2-saved-lists";

const message = (error: unknown) => error instanceof Error && error.message ? error.message : "La liste n’a pas pu être enregistrée.";

/**
 * The shopping lists this account saved: kept on the server with the account, copied in this
 * browser for offline use. Changes show at once and are sent in order; offline, they wait here and
 * leave as soon as the connection is back.
 */
export function useSavedLists(userId: number | null) {
  const [owner, setOwner] = useState(userId);
  const [loaded, setLoaded] = useState(() => readLists(userId));
  const [server, setServer] = useState<SavedList[]>(loaded.lists);
  const [pending, setPending] = useState<ListOp[]>(loaded.queue);
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [error, setError] = useState("");
  if (owner !== userId) {
    const cache = readLists(userId);
    setOwner(userId); setLoaded(cache); setServer(cache.lists); setPending(cache.queue); setError("");
  }
  const serverRef = useRef<SavedList[]>([]);
  const queue = useRef<ListOp[]>([]);
  const sending = useRef(false);
  useEffect(() => { serverRef.current = loaded.lists; queue.current = [...loaded.queue]; }, [loaded]);

  const keep = useCallback((lists: SavedList[]) => {
    serverRef.current = lists; setServer(lists);
    if (userId) writeLists(userId, lists);
  }, [userId]);
  const sync = useCallback(() => {
    setPending([...queue.current]);
    if (userId) writeListsQueue(userId, queue.current);
  }, [userId]);

  const flush = useCallback(async () => {
    if (sending.current || !userId) return;
    sending.current = true;
    try {
      while (queue.current.length) {
        if (!navigator.onLine) { setOffline(true); break; }
        const op = queue.current[0];
        try {
          if (op.op === "put") { const saved = await putList(op.list); keep([saved, ...serverRef.current.filter(list => list.id !== saved.id)]); }
          else if (op.op === "patch") { const saved = await patchList(op.id, { name: op.name, checked: op.checked }); keep(serverRef.current.map(list => list.id === saved.id ? saved : list)); }
          else { await deleteList(op.id); keep(serverRef.current.filter(list => list.id !== op.id)); }
          queue.current.shift(); setOffline(false); setError("");
        } catch (reason) {
          if (!(reason instanceof ListError) || reason.status === 429 || reason.status >= 500) {
            if (!(reason instanceof ListError)) setOffline(true); else setError(message(reason));
            break;
          }
          // Refused (too many lists, a list gone): the change is dropped and the server copy wins.
          queue.current.shift(); setError(message(reason));
          if (reason.status === 401) break;
        } finally { sync(); }
      }
    } finally { sending.current = false; }
  }, [userId, keep, sync]);

  /** Send what waits, then take the server's lists. */
  const refresh = useCallback(async () => {
    if (!userId || !navigator.onLine) return;
    await flush();
    if (queue.current.length) return;
    try { keep((await fetchLists()).lists); setOffline(false); }
    catch (reason) { if (!(reason instanceof ListError)) setOffline(true); }
  }, [userId, flush, keep]);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!userId) return;
    const back = () => { setOffline(false); void refreshRef.current(); };
    const gone = () => setOffline(true);
    // A list saved on another device appears when this page comes back to the front.
    const shown = () => { if (!document.hidden) void refreshRef.current(); };
    void refreshRef.current();
    window.addEventListener("online", back); window.addEventListener("offline", gone);
    document.addEventListener("visibilitychange", shown);
    return () => { window.removeEventListener("online", back); window.removeEventListener("offline", gone); document.removeEventListener("visibilitychange", shown); };
  }, [userId]);

  const change = useCallback((op: ListOp) => {
    queue.current = queueListOp(queue.current, op); sync();
    void flush();
  }, [sync, flush]);
  const lists = useMemo(() => applyListOps(server, pending), [server, pending]);

  return {
    lists, offline, error, waiting: pending.length,
    clearError: () => setError(""),
    /** Save a copy of a shopping list; returns its id, at once (offline too). */
    save(name: string, content: SavedListContent, checked: string[] = []): string {
      const now = new Date().toISOString(), id = newListId();
      change({ op: "put", list: { id, name, content, checked, created_at: now, updated_at: now } });
      return id;
    },
    rename: (id: string, name: string) => change({ op: "patch", id, name }),
    setChecked: (id: string, checked: string[]) => change({ op: "patch", id, checked }),
    remove: (id: string) => change({ op: "delete", id }),
  };
}
export type SavedListsControls = ReturnType<typeof useSavedLists>;
