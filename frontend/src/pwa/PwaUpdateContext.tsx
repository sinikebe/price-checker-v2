import { useEffect, useState, type ReactNode } from "react";
import { PwaUpdateContext, type CheckState } from "./PwaUpdateState";
import { useRegisterSW } from "virtual:pwa-register/react";

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registered) { if (registered) setRegistration(registered); },
  });

  useEffect(() => {
    if (!registration) return;
    const check = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void registration.update().catch(() => {});
    };
    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
    };
  }, [registration]);

  async function checkForUpdates() {
    if (!navigator.onLine) { setCheckState("offline"); return; }
    if (!("serviceWorker" in navigator)) { setCheckState("unsupported"); return; }
    setCheckState("checking");
    try {
      let current = registration ?? await navigator.serviceWorker.getRegistration("/v2");
      if (!current) {
        current = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 4000)),
        ]);
      }
      if (!current) { setCheckState("unsupported"); return; }
      await current.update();
      if (current.waiting) { setCheckState("available"); return; }
      const installing = current.installing;
      if (installing) {
        const finished = await new Promise<boolean>((resolve) => {
          const finish = (ok: boolean) => {
            installing.removeEventListener("statechange", changed);
            window.clearTimeout(timer);
            resolve(ok);
          };
          const changed = () => {
            if (["installed", "redundant", "activated"].includes(installing.state)) finish(installing.state !== "redundant");
          };
          const timer = window.setTimeout(() => finish(false), 15000);
          installing.addEventListener("statechange", changed);
          changed();
        });
        if (!finished) { setCheckState("error"); return; }
      }
      setCheckState(current.waiting ? "available" : "current");
    } catch {
      setCheckState("error");
    }
  }

  return <PwaUpdateContext.Provider value={{
    needRefresh, dismissUpdate: () => { setNeedRefresh(false); setCheckState("idle"); },
    checkState: needRefresh ? "available" : checkState, checkForUpdates,
    applyUpdate: async () => { try { await updateServiceWorker(true); } catch { setNeedRefresh(false); setCheckState("error"); } },
  }}>{children}</PwaUpdateContext.Provider>;
}
