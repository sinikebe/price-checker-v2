import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import V2AccountSecurity from "./V2AccountSecurity";
import V2AvailabilitySettings from "./V2AvailabilitySettings";
import V2ConnectorStores from "./V2ConnectorStores";
import V2SettingsAccount from "./V2SettingsAccount";
import V2SettingsGeneral from "./V2SettingsGeneral";
import V2ServerLogs from "./V2ServerLogs";
import V2ServerStats from "./V2ServerStats";
import V2SettingsServer from "./V2SettingsServer";
import V2SiteHeader from "./V2SiteHeader";
import V2SettingsTabs from "./V2SettingsTabs";
import {
  SETTINGS_BASE_PATH, resolveSettingsTab, settingsPanelDomId, settingsTabDomId, visibleSettingsTabs, type SettingsTabId,
} from "./v2-settings-tabs";
import "./v2-settings.css";

export default function V2SettingsPage({ user, tabSlug, onAccountDeleted, onLogout }: {
  user: V2User | null; tabSlug?: string; onAccountDeleted: () => void; onLogout: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [deleteNotice, setDeleteNotice] = useState("");
  const viewer = { loggedIn: Boolean(user), admin: user?.role === "admin" };
  const tabs = visibleSettingsTabs(viewer);
  const { tab, redirect } = resolveSettingsTab(tabSlug, viewer);
  // Panels are mounted on first visit and then kept (hidden): a token or recovery codes shown once
  // must survive a change of tab. The redirect is an effect, not a <Navigate>, so that the page and
  // its "account deleted" notice stay mounted when the viewer's access changes under it.
  const [visited, setVisited] = useState<ReadonlySet<SettingsTabId>>(() => new Set([tab.id]));
  if (!visited.has(tab.id)) setVisited(new Set(visited).add(tab.id));
  useEffect(() => { if (redirect) navigate(SETTINGS_BASE_PATH, { replace: true }); }, [redirect, navigate]);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = (tab.id === "general" ? "" : `${tab.label} | `) + "Paramètres | Price Checker";
    return () => { document.title = previousTitle; };
  }, [tab.id, tab.label]);

  function panel(id: SettingsTabId, active: boolean): ReactNode {
    switch (id) {
      case "general": return <V2SettingsGeneral />;
      case "account": return user && <V2SettingsAccount user={user} onDeleted={cleared => {
        setDeleteNotice(cleared
          ? "Compte supprimé. Vos contenus publiés restent visibles sans votre pseudo."
          : "Compte supprimé sur le serveur. Effacez aussi les données de ce site dans votre navigateur : le nettoyage local n’a pas abouti.");
        onAccountDeleted();
      }} />;
      case "security": return user && <V2AccountSecurity key={user.id} />;
      case "connectors": return user?.role === "admin" && <>
        <V2ConnectorStores key={`stores-${user.id}`} />
        <V2AvailabilitySettings key={`availability-${user.id}`} />
      </>;
      case "server": return user?.role === "admin" && <V2SettingsServer userId={user.id} />;
      case "logs": return user?.role === "admin" && <V2ServerLogs key={`logs-${user.id}`} active={active} />;
      case "stats": return user?.role === "admin" && <V2ServerStats key={`stats-${user.id}`} active={active} />;
    }
  }
  const showTabs = tabs.length > 1;

  return <div className="v2-home v2-settings">
    <a className="v2-skip" href="#v2-settings-main">Aller au contenu</a>
    <V2SiteHeader user={user} onLogout={onLogout} />
    <main id="v2-settings-main" className="v2-wrap v2-settings-main">
      <span className="v2-section-kicker">PRÉFÉRENCES</span>
      <h1>Paramètres<span>.</span></h1>
      {deleteNotice && <p className="v2-settings-success" role="status">{deleteNotice}</p>}
      {showTabs && <V2SettingsTabs tabs={tabs} activeId={tab.id} />}
      {tabs.filter(item => item.id === tab.id || visited.has(item.id)).map(item => {
        const active = item.id === tab.id;
        const grid = <div className="v2-settings-grid">{panel(item.id, active)}</div>;
        return showTabs
          ? <div key={item.id} className="v2-settings-panel" role="tabpanel" id={settingsPanelDomId(item.id)}
              aria-labelledby={settingsTabDomId(item.id)} hidden={!active}>{grid}</div>
          : <div key={item.id}>{grid}</div>;
      })}
    </main>
  </div>;
}
