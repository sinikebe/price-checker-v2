import { useEffect, useState } from "react";
import "./v2-maintenance.css";

/* Host proxy status is deliberately outside the service worker's precache. */
export default function V2MaintenanceOverlay() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let mounted = true;
    async function check() {
      try {
        const response = await fetch("/v2-maintenance-state", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return;
        const state: unknown = await response.json();
        if (mounted && state && typeof state === "object" && "maintenance" in state)
          setActive((state as { maintenance: unknown }).maintenance === true);
      } catch { /* Keep the last known state while offline. */ }
    }
    const visible = () => { if (!document.hidden) void check(); };
    void check();
    const interval = window.setInterval(() => { if (!document.hidden) void check(); }, 10000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
    };
  }, []);

  if (!active) return null;
  return <div className="v2-maintenance-overlay" role="alertdialog" aria-modal="true" aria-labelledby="v2-maintenance-title">
    <div className="v2-maintenance-panel">
      <span className="v2-maintenance-symbol" aria-hidden="true">🔧</span>
      <h1 id="v2-maintenance-title">Maintenance en cours</h1>
      <p>Price Checker se met à jour. Vos données sont conservées ; revenez dans quelques instants.</p>
      <p className="v2-maintenance-small">Cette page se rétablira automatiquement à la fin de l’opération.</p>
    </div>
  </div>;
}
