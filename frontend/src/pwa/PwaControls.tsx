import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { usePwaInstall } from "./PwaInstallState";
import { usePwaUpdate } from "./PwaUpdateState";
import { AUTH_READY_EVENT } from "../v2/v2-account-session";
import { useOnline } from "../v2/useOnline";
import { normalizePath } from "../v2/v2-site-nav";
import "./pwa-controls.css";
import { syncV2Data } from "./data-sync";

export default function PwaControls() {
  const online = useOnline();
  const { canPrompt, installed, isIos, requestInstall } = usePwaInstall();
  const isHome = normalizePath(useLocation().pathname) === "/v2";
  const { needRefresh, dismissUpdate, applyUpdate } = usePwaUpdate();
  useEffect(() => {
    const connected = () => { if (navigator.onLine) void syncV2Data(); };
    const opened = () => { if (document.visibilityState === "visible") void syncV2Data(); };
    const authenticated = () => { void syncV2Data(); };
    window.addEventListener("online", connected);
    document.addEventListener("visibilitychange", opened);
    window.addEventListener(AUTH_READY_EVENT, authenticated);
    void syncV2Data();
    return () => {
      window.removeEventListener("online", connected);
      document.removeEventListener("visibilitychange", opened);
      window.removeEventListener(AUTH_READY_EVENT, authenticated);
    };
  }, []);
  const showInstall = !isHome && !installed && canPrompt;
  const showIosHint = !isHome && isIos && !installed && !canPrompt;
  if (!needRefresh && online && !showInstall && !showIosHint) return null;
  return <div className="pwa-controls" role="status" aria-live="polite">
    {!online && <span>Hors ligne · lecture seule : paniers, listes et recettes enregistrés ; les coches des listes partent au retour de la connexion</span>}
    {needRefresh && <><span>Nouvelle version disponible</span><button type="button" onClick={() => void applyUpdate()}>Mettre à jour</button><button type="button" onClick={() => dismissUpdate()}>Plus tard</button></>}
    {showInstall && <button type="button" onClick={() => void requestInstall()}>Installer l’app</button>}
    {showIosHint && <span>Pour installer : Partager → Sur l’écran d’accueil</span>}
  </div>;
}
