import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { usePwaInstall } from "./PwaInstallContext";
import { usePwaUpdate } from "./PwaUpdateState";
import "./pwa-controls.css";
import { syncV2Data } from "./data-sync";

export default function PwaControls() {
  const [online, setOnline] = useState(navigator.onLine);
  const { canPrompt, installed, isIos, requestInstall } = usePwaInstall();
  const isHome = useLocation().pathname.replace(/\/+$/, "") === "/v2";
  const { needRefresh, dismissUpdate, applyUpdate } = usePwaUpdate();
  useEffect(() => {
    const connected = () => { setOnline(navigator.onLine); if (navigator.onLine) void syncV2Data(); };
    const opened = () => { if (document.visibilityState === "visible") void syncV2Data(); };
    const authenticated = () => { void syncV2Data(); };
    window.addEventListener("online", connected);
    window.addEventListener("offline", connected);
    document.addEventListener("visibilitychange", opened);
    window.addEventListener("v2-auth-ready", authenticated);
    void syncV2Data();
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", connected);
      document.removeEventListener("visibilitychange", opened);
      window.removeEventListener("v2-auth-ready", authenticated);
    };
  }, []);
  const showInstall = !isHome && !installed && canPrompt;
  const showIosHint = !isHome && isIos && !installed && !canPrompt;
  if (!needRefresh && online && !showInstall && !showIosHint) return null;
  return <div className="pwa-controls" role="status" aria-live="polite">
    {!online && <span>Hors ligne · panier et recettes enregistrés disponibles</span>}
    {needRefresh && <><span>Nouvelle version disponible</span><button type="button" onClick={() => void applyUpdate()}>Mettre à jour</button><button type="button" onClick={() => dismissUpdate()}>Plus tard</button></>}
    {showInstall && <button type="button" onClick={() => void requestInstall()}>Installer l’app</button>}
    {showIosHint && <span>Pour installer : Partager → Sur l’écran d’accueil</span>}
  </div>;
}
