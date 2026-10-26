import { useEffect, useState } from "react";
import { usePwaUpdate } from "./PwaUpdateState";
import "./pwa-controls.css";
import { flushV2BasketOps, syncV2Data } from "./data-sync";
import { V2_BASKET_LOCAL_CHANGE } from "../v2/v2-basket-storage";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export default function PwaControls() {
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [installed, setInstalled] = useState(window.matchMedia("(display-mode: standalone)").matches);
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const { needRefresh, dismissUpdate, applyUpdate } = usePwaUpdate();
  useEffect(() => {
    const install = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    const installedNow = () => { setInstallEvent(null); setInstalled(true); };
    const connected = () => { setOnline(navigator.onLine); if (navigator.onLine) void syncV2Data().then(flushV2BasketOps); };
    const opened = () => { if (document.visibilityState === "visible") void syncV2Data(); };
    const authenticated = () => { void syncV2Data().then(flushV2BasketOps); };
    let basketTimer: ReturnType<typeof setTimeout> | undefined;
    const basketChanged = () => { clearTimeout(basketTimer); basketTimer = setTimeout(() => void flushV2BasketOps(), 300); };
    window.addEventListener("beforeinstallprompt", install);
    window.addEventListener("appinstalled", installedNow);
    window.addEventListener("online", connected);
    window.addEventListener("offline", connected);
    document.addEventListener("visibilitychange", opened);
    window.addEventListener("v2-auth-ready", authenticated);
    window.addEventListener(V2_BASKET_LOCAL_CHANGE, basketChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("appinstalled", installedNow);
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", connected);
      document.removeEventListener("visibilitychange", opened);
      window.removeEventListener("v2-auth-ready", authenticated);
      window.removeEventListener(V2_BASKET_LOCAL_CHANGE, basketChanged);
      clearTimeout(basketTimer);
    };
  }, []);
  async function askInstall() {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  }
  if (!needRefresh && !installEvent && online && (!isIos || installed)) return null;
  return <div className="pwa-controls" role="status" aria-live="polite">
    {!online && <span>Hors ligne · panier et recettes enregistrés disponibles</span>}
    {needRefresh && <><span>Nouvelle version disponible</span><button type="button" onClick={() => void applyUpdate()}>Mettre à jour</button><button type="button" onClick={() => dismissUpdate()}>Plus tard</button></>}
    {installEvent && !installed && <button type="button" onClick={() => void askInstall()}>Installer l’app</button>}
    {isIos && !installed && !installEvent && <span>Pour installer : Partager → Sur l’écran d’accueil</span>}
  </div>;
}
