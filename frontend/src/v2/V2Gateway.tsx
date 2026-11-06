import { useEffect, useState, type ReactNode } from "react";
import { useConfirm } from "./useConfirm";
import { unsentAtLogout } from "./v2-account-local-keys";
import { ACCOUNT_DELETED_KEY, AUTH_CHANGED_KEY, AUTH_READY_EVENT, clearSignedOutData } from "./v2-account-session";
import { Navigate, useLocation } from "react-router-dom";
import V2AuthPage from "./V2AuthPage";
import V2SetupPage, { SetupFrame } from "./V2SetupPage";
import { authRequest, type V2AuthStatus, type V2User } from "./v2-auth-api";
import { errorText } from "./v2-http";
import { SetupNetworkError, setupRequest, type SetupStatus } from "./v2-setup-api";
import V2SettingsPage from "./V2SettingsPage";
import V2HostAlertNotice from "./V2HostAlertNotice";
import V2HomePage from "./V2HomePage";
import V2ProductWorkspace from "./V2ProductWorkspace";
import V2CataloguePage from "./V2CataloguePage";
import V2RecipesPage from "./V2RecipesPage";
import V2BasketPage from "./V2BasketPage";
import V2BasketDemoPage from "./V2BasketDemoPage";
import V2CapturePage from "./V2CapturePage";
import V2CompletionPage from "./V2CompletionPage";
import V2StoresPage from "./V2StoresPage";
import { V2AppModeProvider } from "./V2AppMode";
import { V2SiteFilterProvider } from "./V2SiteFilter";
import V2ShoppingOnly from "./V2ShoppingOnly";
import { offlineUser, rememberOfflineUser } from "./v2-offline-user";
import { activateBasketUser, activeBasketUser } from "./v2-basket-storage";
import type { V2Route } from "./v2-site-nav";
import "./v2-home.css";

function errorMessage(error: unknown): string {
  return errorText(error, "Une erreur inattendue est survenue.");
}

/** The pages under the application's own header: what the server's state allows, then the page of the route. */
export default function V2Gateway({ route }: { route: Exclude<V2Route, { kind: "legal" | "versions" | "changelog" }> }) {
  const confirm = useConfirm();
  const location = useLocation();
  const [loginRedirect, setLoginRedirect] = useState("/v2");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<V2AuthStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setupRequest<SetupStatus>("status")
      .then((data) => { if (active) setStatus(data); })
      .catch((reason: unknown) => { if (active) { if (!navigator.onLine || reason instanceof SetupNetworkError) setStatus({ configured: true, app_env: "offline" }); else setError(errorMessage(reason)); } });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    if (!status?.configured) return;
    let active = true;
    authRequest<V2AuthStatus>("status")
      .then((data) => { if (active) { if (data.user) rememberOfflineUser(data.user); setAuthStatus(data); } })
      // Offline, the account last signed in here stays known, so its baskets, prices and lists open.
      .catch((reason: unknown) => { if (active) { if (!navigator.onLine || reason instanceof TypeError || status.app_env === "offline") setAuthStatus({ admin_initialized: true, user: offlineUser(activeBasketUser()) }); else setError(errorMessage(reason)); } });
    return () => { active = false; };
  }, [status?.configured, status?.app_env, attempt]);

  // Opened offline: ask the server again as soon as the connection is back (the session may have ended).
  useEffect(() => {
    if (status?.app_env !== "offline") return;
    const back = () => setAttempt(value => value + 1);
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, [status?.app_env]);

  useEffect(() => {
    if (!status?.configured || !authStatus) return;
    activateBasketUser(authStatus.user?.id ?? null, status.app_env === "offline");
    window.dispatchEvent(new Event(AUTH_READY_EVENT));
  }, [status?.configured, status?.app_env, authStatus]);

  useEffect(() => {
    const accountDeletedElsewhere = (event: StorageEvent) => {
      if (event.key !== ACCOUNT_DELETED_KEY && event.key !== AUTH_CHANGED_KEY) return;
      setAuthStatus(null);
      setAttempt(value => value + 1);
    };
    window.addEventListener("storage", accountDeletedElsewhere);
    return () => window.removeEventListener("storage", accountDeletedElsewhere);
  }, []);

  function authenticated(user: V2User) {
    // Remembered now, as the session read at start-up is: offline before the next reload, the account still opens.
    rememberOfflineUser(user);
    const next = route.kind === "auth" ? new URLSearchParams(location.search).get("next") : null;
    setLoginRedirect(next === "capture" ? "/v2/capture" : next === "panier" ? "/v2/panier" : "/v2");
    setAuthStatus({ admin_initialized: true, user });
  }

  async function logout() {
    const userId = authStatus?.user?.id ?? null;
    if (userId) {
      // Signing out erases the account's private data from this device: say what was never sent.
      let unsent = { changes: 0, drafts: 0 };
      try { unsent = unsentAtLogout(localStorage, userId); } catch { /* storage unavailable: nothing kept */ }
      const lost = [unsent.changes ? `${unsent.changes} modification${unsent.changes > 1 ? "s" : ""} du panier partagé pas encore envoyée${unsent.changes > 1 ? "s" : ""}` : null,
        unsent.drafts ? `${unsent.drafts} brouillon${unsent.drafts > 1 ? "s" : ""} non envoyé${unsent.drafts > 1 ? "s" : ""}` : null].filter(Boolean);
      if (lost.length && !await confirm({ title: "Se déconnecter", message: `Se déconnecter efface de cet appareil : ${lost.join(" et ")}. Se déconnecter quand même ?`, confirmLabel: "Se déconnecter", danger: true })) return;
    }
    try {
      await authRequest<void>("logout", "POST");
      if (userId) clearSignedOutData(userId);
      setAuthStatus((previous) => previous ? { ...previous, user: null } : previous);
      // Other tabs recheck the session instead of showing a signed-in page.
      try { localStorage.setItem(AUTH_CHANGED_KEY, String(Date.now())); } catch { /* the other tabs update on their next request */ }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (error) {
    return <SetupFrame><div className="v2-setup-state" role="alert">
      <h1>Service indisponible</h1><p>{error}</p>
      <button className="v2-setup-primary" onClick={() => {
        setError(""); setAttempt((value) => value + 1);
      }}>Réessayer</button>
    </div></SetupFrame>;
  }
  if (!status) {
    return <SetupFrame><div className="v2-setup-state" role="status">Chargement de la configuration…</div></SetupFrame>;
  }
  if (!status.configured) {
    return <V2SetupPage configured={false} environment={status.app_env}
      onConfigured={() => setStatus({ ...status, configured: true })} />;
  }
  if (!authStatus) {
    return <SetupFrame><div className="v2-setup-state" role="status">Chargement de votre espace…</div></SetupFrame>;
  }
  if (route.kind === "database") {
    if (authStatus.admin_initialized && authStatus.user?.role !== "admin") return <Navigate to="/v2" replace />;
    return <V2SetupPage configured environment={status.app_env}
      onConfigured={() => setStatus({ ...status, configured: true })} />;
  }
  const adminId = authStatus.user?.role === "admin" ? authStatus.user.id : null;
  // Every page knows the mode in use: shopping (baskets and lists) or contribution (products, stores, recipes).
  const withMode = (page: ReactNode) => <V2AppModeProvider userId={authStatus.user?.id ?? null}>
    <V2SiteFilterProvider userId={authStatus.user?.id ?? null}>{page}</V2SiteFilterProvider></V2AppModeProvider>;
  const withHostAlert = (page: ReactNode) => withMode(adminId !== null ? <><V2HostAlertNotice userId={adminId} />{page}</> : page);
  if (route.kind === "settings") return withMode(<V2SettingsPage user={authStatus.user} tabSlug={route.tab} onLogout={logout} onAccountDeleted={() => {
    setAuthStatus(previous => previous ? { ...previous, user: null } : previous);
  }} />);
  if (!authStatus.admin_initialized) {
    return <V2AuthPage mode="admin" environment={status.app_env} onAuthenticated={authenticated} />;
  }
  if (route.kind === "auth") {
    if (authStatus.user) return <Navigate to={loginRedirect} replace />;
    return <V2AuthPage mode={route.mode} environment={status.app_env} onAuthenticated={authenticated} />;
  }
  switch (route.kind) {
    case "stores": return withHostAlert(<V2StoresPage key={route.id ?? "list"} id={route.id} user={authStatus.user} onLogout={logout} />);
    case "completion": return withHostAlert(<V2CompletionPage user={authStatus.user} onLogout={logout} />);
    case "capture": return withHostAlert(<V2CapturePage mode={route.mode} user={authStatus.user} onLogout={logout} />);
    case "basket": return withHostAlert(route.demo ? <V2BasketDemoPage user={authStatus.user} onLogout={logout} listMode={route.list} />
      : <V2ShoppingOnly user={authStatus.user} onLogout={logout}>
        <V2BasketPage user={authStatus.user} onLogout={logout} sharedMode={route.shared} listMode={route.list} /></V2ShoppingOnly>);
    case "recipes":
      return withHostAlert(<V2RecipesPage mode={route.mode} id={route.id} privateRecipe={route.private} user={authStatus.user} onLogout={logout} />);
    case "catalogue": return withHostAlert(<V2CataloguePage name={route.category} user={authStatus.user} onLogout={logout} />);
    case "workspace":
      return withHostAlert(<V2ProductWorkspace key={route.mode + ":" + route.id} mode={route.mode} id={route.id} user={authStatus.user} onLogout={logout} />);
    default: return withHostAlert(<V2HomePage user={authStatus.user} onLogout={logout} />);
  }
}
