import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useConfirm } from "./useConfirm";
import { unsentAtLogout } from "./v2-account-local-keys";
import { ACCOUNT_DELETED_KEY, AUTH_CHANGED_KEY, AUTH_READY_EVENT, clearSignedOutData } from "./v2-account-session";
import { Link, Navigate, useLocation } from "react-router-dom";
import V2AuthPage from "./V2AuthPage";
import V2Brand from "./V2Brand";
import { authRequest, type V2AuthStatus, type V2User } from "./v2-auth-api";
import { errorText } from "./v2-http";
import { SetupNetworkError, setupRequest, type Provider, type PublicDatabase, type SetupStatus, type TlsMode } from "./v2-setup-api";
import { useDocumentTitle } from "./useDocumentTitle";
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
import "./v2-home.css";
import "./v2-setup.css";

type FormValues = PublicDatabase & { password: string };

function emptyForm(): FormValues {
  return {
    provider: "postgres",
    project_url: "",
    host: "",
    port: 5432,
    database: "",
    username: "",
    password: "",
    tls_mode: "verify-full",
    public_hostname: "",
  };
}

function errorMessage(error: unknown): string {
  return errorText(error, "Une erreur inattendue est survenue.");
}

function SetupFrame({ children }: { children: ReactNode }) {
  useDocumentTitle("Configuration | Price Checker");

  return (
    <div className="v2-home v2-setup">
      <a className="v2-skip" href="#v2-setup-main">Aller au contenu</a>
      <header className="v2-header">
        <div className="v2-wrap v2-header-inner">
          <V2Brand />
          <span className="v2-setup-header-label">Configuration de Price Checker</span>
        </div>
      </header>
      <main id="v2-setup-main" className="v2-setup-main v2-wrap">{children}</main>
    </div>
  );
}

function HostnameSettings({ environment }: { environment: string }) {
  const [hostname, setHostname] = useState("");
  const [savedHostname, setSavedHostname] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setupRequest<{ public_hostname: string }>("hostname")
      .then((data) => { if (active) { setHostname(data.public_hostname); setSavedHostname(data.public_hostname); setLoaded(true); } })
      .catch((reason: unknown) => { if (active) { setMessage(errorMessage(reason)); setLoadFailed(true); } });
    return () => { active = false; };
  }, [loadAttempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = await setupRequest<{ public_hostname: string }>("hostname", "PUT", {
        public_hostname: hostname,
        expected_hostname: savedHostname,
      });
      setHostname(data.public_hostname);
      setSavedHostname(data.public_hostname);
      setError(false);
      setMessage(data.public_hostname
        ? "Nom d’hôte enregistré. Vérifiez que la résolution du nom et HTTPS sont configurés séparément si nécessaire."
        : "Nom d’hôte effacé. L’accès HTTPS reste configuré séparément.");
    } catch (reason) {
      setError(true);
      setMessage(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed) return <div className="v2-setup-card v2-setup-hostname" role="alert">
    <p>{message}</p><button className="v2-setup-secondary" onClick={() => { setLoadFailed(false); setLoadAttempt((value) => value + 1); }}>Réessayer</button>
  </div>;
  if (!loaded) return <div className="v2-setup-card v2-setup-hostname" role="status">Chargement du domaine…</div>;

  return <form className="v2-setup-card v2-setup-hostname" onSubmit={save}>
    <div className="v2-setup-card-heading">
      <span className="v2-setup-step">01</span>
      <div><h2>Adresse de l’instance</h2><p>Nom local, domaine ou adresse IP utilisé pour accéder à cette instance.</p></div>
    </div>
    <div className="v2-setup-field">
      <label htmlFor="v2-public-hostname-settings">Nom d’hôte</label>
      <input id="v2-public-hostname-settings" type="text" autoCapitalize="off" spellCheck={false}
        placeholder={environment === "dev" ? "machine.local" : "exemple.org"} value={hostname}
        onChange={(event) => { setHostname(event.target.value); setMessage(""); }} disabled={busy} required={environment !== "dev"} />
      <small>Nom d’hôte ou adresse IP, sans https://, port ni chemin. {environment === "dev" && "Laissez vide pour ne pas définir de nom d’hôte. "}Ce réglage ne configure ni la résolution du nom ni HTTPS.</small>
    </div>
    <div className="v2-setup-actions"><button className="v2-setup-primary" disabled={busy}>
      {busy ? "Enregistrement…" : "Enregistrer le nom d’hôte"}
    </button></div>
    {message && <p className={"v2-setup-message " + (error ? "v2-setup-error" : "v2-setup-success")}
      role={error ? "alert" : "status"}>{message}</p>}
  </form>;
}

function SetupPage({ configured, environment, onConfigured }: { configured: boolean; environment: string; onConfigured: () => void }) {
  const [accessCode, setAccessCode] = useState("");
  const [unlocked, setUnlocked] = useState(!configured);
  const [form, setForm] = useState<FormValues>(() => emptyForm());
  const [savedProvider, setSavedProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<"unlock" | "test" | "save" | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setSuccess(false);
    setMessage("");
  }

  function changeProvider(provider: Provider) {
    setForm({ ...emptyForm(), provider, public_hostname: form.public_hostname,
      tls_mode: "verify-full",
    });
    setMessage("");
    setSuccess(false);
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("unlock");
    setMessage("");
    try {
      const data = await setupRequest<PublicDatabase>("database/details", "POST", {
        access_code: accessCode,
      });
      setForm({ ...data, password: "" });
      setSavedProvider(data.provider);
      setUnlocked(true);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const isTest = action?.value === "test";
    setBusy(isTest ? "test" : "save");
    setMessage("");
    setSuccess(false);
    const payload = { ...form, public_hostname: configured ? undefined : form.public_hostname, access_code: accessCode };
    try {
      if (isTest) {
        await setupRequest("database/test", "POST", payload);
        setMessage(configured
          ? "Connexion établie. Les paramètres enregistrés n’ont pas été modifiés."
          : "Connexion établie. Aucun paramètre n’a encore été enregistré.");
        setSuccess(true);
      } else {
        if (configured) {
          await setupRequest("database", "PUT", payload);
          setMessage("Paramètres enregistrés et connexion vérifiée.");
          setSuccess(true);
        } else {
          await setupRequest("database", "POST", payload);
          onConfigured();
        }
        setForm((current) => ({ ...current, password: "" }));
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SetupFrame>
      <div className="v2-setup-intro">
        <span className="v2-section-kicker">{configured ? "PARAMÈTRES · SERVEUR" : "PREMIER DÉMARRAGE"}</span>
        <h1>{configured ? "Paramètres du serveur." : <>Configurer le <em>serveur.</em></>}</h1>
        <p>{configured
          ? "Le nom d’hôte peut être modifié avec un compte administrateur. Le code du serveur reste nécessaire pour modifier la connexion à la base de données."
          : "Renseignez l’adresse de cette installation et les paramètres de sa base de données. La connexion sera vérifiée avant l’activation des comptes."}</p>
      </div>

      {configured && <HostnameSettings environment={environment} />}
      {configured && !unlocked ? <form className="v2-setup-card v2-setup-unlock" onSubmit={unlock}>
        <label htmlFor="v2-access-code">Code administrateur du serveur</label>
        <input id="v2-access-code" type="password" autoComplete="off" value={accessCode}
          onChange={(event) => setAccessCode(event.target.value)} required />
        <button className="v2-setup-primary" disabled={busy !== null}>Afficher les paramètres PostgreSQL</button>
        {message && <p className="v2-setup-message v2-setup-error" role="alert">{message}</p>}
      </form> : <div className="v2-setup-layout">
        <form className="v2-setup-card" onSubmit={submit}>
          {!configured && <>
            <div className="v2-setup-card-heading">
              <span className="v2-setup-step">01</span>
              <div><h2>Adresse de l’instance</h2><p>Nom local, domaine ou adresse IP utilisé pour accéder à cette instance.</p></div>
            </div>
            <div className="v2-setup-fields v2-setup-domain-fields">
              <div className="v2-setup-field v2-setup-field-wide">
                <label htmlFor="v2-public-hostname">Nom d’hôte</label>
                <input id="v2-public-hostname" type="text" autoCapitalize="off" spellCheck={false}
                  placeholder={environment === "dev" ? "machine.local" : "exemple.org"} value={form.public_hostname ?? ""}
                  onChange={(event) => update("public_hostname", event.target.value)} required={environment !== "dev"} />
                <small>Nom d’hôte ou adresse IP, sans https://, port ni chemin. La résolution du nom et HTTPS se configurent séparément.</small>
              </div>
            </div>
          </>}
          <div className="v2-setup-card-heading">
            <span className="v2-setup-step">02</span>
            <div><h2>Base de données</h2><p>Configurez la base PostgreSQL de cette instance.</p></div>
          </div>

          <fieldset className="v2-setup-provider">
            <legend>Type de base</legend>
            <label className={form.provider === "postgres" ? "v2-setup-provider-active" : ""}>
              <input type="radio" name="provider" value="postgres" checked={form.provider === "postgres"}
                onChange={() => changeProvider("postgres")} />
              <span><strong>PostgreSQL auto-hébergé</strong><small>Pour le développement ou votre propre serveur.</small></span>
            </label>
            <label className={form.provider === "supabase" ? "v2-setup-provider-active" : ""}>
              <input type="radio" name="provider" value="supabase" checked={form.provider === "supabase"}
                onChange={() => changeProvider("supabase")} />
              <span><strong>Supabase</strong><small>PostgreSQL hébergé par Supabase.</small></span>
            </label>
          </fieldset>

          <div className="v2-setup-fields">
            {form.provider === "supabase" && (
              <div className="v2-setup-field v2-setup-field-wide">
                <label htmlFor="v2-project-url">URL du projet</label>
                <input id="v2-project-url" type="url" placeholder="https://votre-projet.supabase.co"
                  value={form.project_url} onChange={(event) => update("project_url", event.target.value)} required />
              </div>
            )}
            <div className="v2-setup-field v2-setup-field-wide">
              <label htmlFor="v2-host">{form.provider === "supabase" ? "Hôte du pooler Session" : "Hôte PostgreSQL"}</label>
              <input id="v2-host" type="text" autoCapitalize="off" spellCheck={false}
                placeholder={form.provider === "supabase" ? "exemple.pooler.supabase.com" : "db"}
                value={form.host} onChange={(event) => update("host", event.target.value)} required />
              {form.provider === "supabase"
                ? <small>Supabase → Connect → Session pooler. N’utilisez pas le mode Transaction.</small>
                : <small>Avec l’installation Docker fournie, utilisez « db » : localhost désigne le conteneur de l’API.</small>}
            </div>
            <div className="v2-setup-field">
              <label htmlFor="v2-port">Port</label>
              <input id="v2-port" type="number" min={1} max={65535} value={form.port}
                onChange={(event) => update("port", Number(event.target.value))}
                readOnly={form.provider === "supabase"} required />
            </div>
            <div className="v2-setup-field">
              <label htmlFor="v2-database">Nom de la base</label>
              <input id="v2-database" type="text" value={form.database}
                onChange={(event) => update("database", event.target.value)} required />
            </div>
            <div className="v2-setup-field">
              <label htmlFor="v2-user">Utilisateur</label>
              <input id="v2-user" type="text" autoCapitalize="off" spellCheck={false}
                placeholder={form.provider === "supabase" ? "postgres.votre-projet" : "utilisateur_v2"} value={form.username}
                onChange={(event) => update("username", event.target.value)} required />
            </div>
            <div className="v2-setup-field">
              <label htmlFor="v2-password">Mot de passe PostgreSQL</label>
              <input id="v2-password" type="password" autoComplete="new-password"
                placeholder={configured ? "Laisser vide pour conserver" : "Mot de passe de la base"}
                value={form.password} onChange={(event) => update("password", event.target.value)}
                required={!configured || form.provider !== savedProvider} />
            </div>
            <div className="v2-setup-field v2-setup-field-wide">
              <label htmlFor="v2-tls">Sécurité de la connexion</label>
              <select id="v2-tls" value={form.tls_mode}
                onChange={(event) => update("tls_mode", event.target.value as TlsMode)}
                disabled={form.provider === "supabase"}>
                {environment === "dev" && form.provider === "postgres" && <option value="disable">Sans TLS — serveur de développement local uniquement</option>}
                {form.provider === "postgres" && <option value="require">TLS chiffré</option>}
                <option value="verify-full">TLS chiffré et certificat vérifié</option>
              </select>
            </div>
          </div>

          {!configured && (
            <div className="v2-setup-code">
              <label htmlFor="v2-admin-code">Code d’initialisation</label>
              <input id="v2-admin-code" type="password" autoComplete="off" value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)} required />
              <small>Ce code est fourni par l’administrateur du serveur. Il empêche un visiteur de configurer la base à votre place.</small>
            </div>
          )}

          <div className="v2-setup-actions">
            <button className="v2-setup-secondary" type="submit" value="test" disabled={busy !== null}>
              {busy === "test" ? "Vérification…" : "Tester la connexion"}
            </button>
            <button className="v2-setup-primary" type="submit" value="save" disabled={busy !== null}>
              {busy === "save" ? "Enregistrement…" : configured ? "Enregistrer les modifications" : "Enregistrer et continuer"}
            </button>
          </div>
          {message && <p className={"v2-setup-message " + (success ? "v2-setup-success" : "v2-setup-error")}
            role={success ? "status" : "alert"}>{message}</p>}
        </form>

        <aside className="v2-setup-aside">
          <div className="v2-setup-aside-icon" aria-hidden="true">✦</div>
          <h2>Une base pour vos données.</h2>
          <p>La connexion est vérifiée avant d’enregistrer la configuration.</p>
          <div className="v2-setup-aside-rule" />
          <div className="v2-setup-aside-point"><span>✓</span><p>Connexion testée avant l’enregistrement ; TLS obligatoire hors du développement local</p></div>
          <div className="v2-setup-aside-point"><span>✓</span><p>Mot de passe conservé côté serveur, jamais dans le navigateur</p></div>
          <div className="v2-setup-aside-point"><span>✓</span><p>La base est initialisée après confirmation</p></div>
          {form.provider === "supabase" && (
            <a href="https://supabase.com/docs/guides/database/connecting-to-postgres" target="_blank" rel="noreferrer">
              Où trouver ces paramètres ? <span aria-hidden="true">↗</span>
            </a>
          )}
        </aside>
      </div>}
      {configured && <p className="v2-setup-back"><Link to="/v2">← Retour à l’accueil</Link></p>}
    </SetupFrame>
  );
}

export default function V2Gateway({ settingsMode = false, preferencesMode = false, preferencesTab, authMode, workspaceMode, workspaceId, categoryName, recipeMode, recipeId, privateRecipe = false, basketMode = false, sharedBasketMode = false, demoBasketMode = false, shoppingListMode = false, captureMode, completionMode = false, storesMode = false, storeId }: {
  settingsMode?: boolean;
  preferencesTab?: string;
  preferencesMode?: boolean;
  authMode?: "login" | "register";
  workspaceMode?: "catalogue" | "mine" | "review" | "new" | "edit" | "draft" | "detail" | "history";
  workspaceId?: number;
  categoryName?: string;
  recipeMode?: "list" | "detail" | "new" | "edit";
  recipeId?: number;
  privateRecipe?: boolean;
  basketMode?: boolean;
  sharedBasketMode?: boolean;
  /** The demo basket of the home page. */
  demoBasketMode?: boolean;
  shoppingListMode?: boolean;
  captureMode?: "install" | "review";
  completionMode?: boolean;
  storesMode?: boolean;
  storeId?: number;
}) {
  const confirm = useConfirm();
  const route = useLocation();
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
    const next = authMode ? new URLSearchParams(route.search).get("next") : null;
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
    return <SetupPage configured={false} environment={status.app_env}
      onConfigured={() => setStatus({ ...status, configured: true })} />;
  }
  if (!authStatus) {
    return <SetupFrame><div className="v2-setup-state" role="status">Chargement de votre espace…</div></SetupFrame>;
  }
  if (settingsMode) {
    if (authStatus.admin_initialized && authStatus.user?.role !== "admin") return <Navigate to="/v2" replace />;
    return <SetupPage configured environment={status.app_env}
      onConfigured={() => setStatus({ ...status, configured: true })} />;
  }
  const adminId = authStatus.user?.role === "admin" ? authStatus.user.id : null;
  // Every page knows the mode in use: shopping (baskets and lists) or contributing (contributing).
  const withMode = (page: ReactNode) => <V2AppModeProvider userId={authStatus.user?.id ?? null}>
    <V2SiteFilterProvider userId={authStatus.user?.id ?? null}>{page}</V2SiteFilterProvider></V2AppModeProvider>;
  const withHostAlert = (page: ReactNode) => withMode(adminId !== null && !preferencesMode
    ? <><V2HostAlertNotice userId={adminId} />{page}</> : page);
  if (preferencesMode) return withMode(<V2SettingsPage user={authStatus.user} tabSlug={preferencesTab} onLogout={logout} onAccountDeleted={() => {
    setAuthStatus(previous => previous ? { ...previous, user: null } : previous);
  }} />);
  if (!authStatus.admin_initialized) {
    return <V2AuthPage mode="admin" environment={status.app_env} onAuthenticated={authenticated} />;
  }
  if (authMode) {
    if (authStatus.user) return <Navigate to={loginRedirect} replace />;
    return <V2AuthPage mode={authMode} environment={status.app_env} onAuthenticated={authenticated} />;
  }
  if (storesMode) return withHostAlert(<V2StoresPage key={storeId ?? "list"} id={storeId} user={authStatus.user} onLogout={logout} />);
  if (completionMode) return withHostAlert(<V2CompletionPage user={authStatus.user} onLogout={logout} />);
  if (captureMode) return withHostAlert(<V2CapturePage mode={captureMode} user={authStatus.user} onLogout={logout} />);
  if (basketMode) return withHostAlert(demoBasketMode ? <V2BasketDemoPage user={authStatus.user} onLogout={logout} listMode={shoppingListMode} />
    : <V2ShoppingOnly user={authStatus.user} onLogout={logout}>
      <V2BasketPage user={authStatus.user} onLogout={logout} sharedMode={sharedBasketMode} listMode={shoppingListMode} /></V2ShoppingOnly>);
  if (recipeMode) {
    return withHostAlert(<V2RecipesPage mode={recipeMode} id={recipeId} privateRecipe={privateRecipe} user={authStatus.user} onLogout={logout} />);
  }
  if (workspaceMode === "catalogue" || categoryName) return withHostAlert(<V2CataloguePage name={categoryName} user={authStatus.user} onLogout={logout} />);
  if (workspaceMode) {
    return withHostAlert(<V2ProductWorkspace key={workspaceMode + ":" + workspaceId} mode={workspaceMode} id={workspaceId} user={authStatus.user} onLogout={logout} />);
  }
  return withHostAlert(<V2HomePage user={authStatus.user} onLogout={logout} />);
}
