import { useEffect, useState, type FormEvent } from "react";
import {
  REGENERATE_CONFIRMATION, activationNotice, activationWarning, disableConfirmation,
} from "./v2-account-security-text";

type MfaState = { enabled: boolean; pending: boolean; recovery_codes_remaining: number };
type TokenRecord = {
  id: number; label: string; scope: "read" | "contribute";
  created_at: string; expires_at: string; last_used_at: string | null;
};
type SetupResult = { secret: string; provisioning_uri: string };
type RecoveryResult = { recovery_codes: string[] };
type TokenResult = TokenRecord & { token: string };

async function securityRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch("/api/v2/account/security/" + path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data
      ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof detail === "string" ? detail : "L’opération a échoué.");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function date(value: string): string {
  return new Date(value).toLocaleDateString("fr-FR");
}

/** A password and a second-factor code that belong to one form only, so forms never share what is typed. */
function useCredentials() {
  const [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  return { password, factor, setPassword, setFactor, clear: () => { setPassword(""); setFactor(""); } };
}

export default function V2AccountSecurity() {
  const [mfa, setMfa] = useState<MfaState | null>(null);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [setup, setSetup] = useState<SetupResult | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState("");
  const setupForm = useCredentials();
  const regenerateForm = useCredentials();
  const disableForm = useCredentials();
  const tokenForm = useCredentials();
  const [confirmCode, setConfirmCode] = useState("");
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"read" | "contribute">("read");
  const [expiry, setExpiry] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const [nextMfa, nextTokens] = await Promise.all([
      securityRequest<MfaState>("mfa"), securityRequest<TokenRecord[]>("tokens"),
    ]);
    setMfa(nextMfa); setTokens(nextTokens);
  }
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "L’opération a échoué."); }
    finally { setBusy(false); }
  }

  function prepare(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setCodes([]);
      setSetup(await securityRequest<SetupResult>("mfa/setup", "POST", { password: setupForm.password }));
      setupForm.clear();
      setNotice("Ajoutez cette clé dans votre application d’authentification, puis confirmez avec un code.");
    });
  }
  function confirm(event: FormEvent) {
    event.preventDefault();
    const revoked = tokens.length;
    void run(async () => {
      const result = await securityRequest<RecoveryResult>("mfa/confirm", "POST", { code: confirmCode });
      setCodes(result.recovery_codes); setSetup(null); setConfirmCode("");
      tokenForm.clear();
      setNotice(activationNotice(revoked));
    });
  }
  function regenerate(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(REGENERATE_CONFIRMATION)) return;
    void run(async () => {
      const result = await securityRequest<RecoveryResult>("mfa/recovery-codes", "POST", {
        password: regenerateForm.password, second_factor: regenerateForm.factor,
      });
      setCodes(result.recovery_codes); regenerateForm.clear();
      setNotice("Les anciens codes de secours sont annulés.");
    });
  }
  function disable(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(disableConfirmation(tokens.length))) return;
    void run(async () => {
      await securityRequest<void>("mfa/disable", "POST", {
        password: disableForm.password, second_factor: disableForm.factor,
      });
      setCodes([]); disableForm.clear(); regenerateForm.clear(); tokenForm.clear();
      setNotice("Double authentification désactivée. Les jetons API ont été révoqués.");
    });
  }
  function createToken(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await securityRequest<TokenResult>("tokens", "POST", {
        label, scope, expires_in_days: expiry, password: tokenForm.password,
        second_factor: mfa?.enabled ? tokenForm.factor : null,
      });
      setCreatedToken(result.token); tokenForm.clear(); setLabel("");
      setNotice("Jeton créé. Copiez-le maintenant : il ne sera plus affiché.");
    });
  }
  function revoke(id: number) {
    void run(async () => {
      await securityRequest<void>(`tokens/${id}`, "DELETE");
      setNotice("Jeton révoqué.");
    });
  }

  return <>
    <section className="v2-settings-card v2-account-security" aria-labelledby="v2-mfa-heading">
      <h2 id="v2-mfa-heading">Double authentification</h2>
      <p>Protégez votre connexion avec une application d’authentification et des codes de secours à usage unique.</p>
      {mfa === null ? <p>Chargement…</p> : mfa.enabled ? <>
        <p><strong>Activée</strong> · {mfa.recovery_codes_remaining} code(s) de secours restant(s).</p>
        <p className="v2-settings-note">Pour modifier cette protection, confirmez votre mot de passe et un code actuel ou de secours.</p>
        <form onSubmit={regenerate} className="v2-security-form">
          <h3>Renouveler les codes de secours</h3>
          <label>Mot de passe<input type="password" autoComplete="current-password" required value={regenerateForm.password} onChange={event => regenerateForm.setPassword(event.target.value)} /></label>
          <label>Code actuel ou de secours<input type="text" autoComplete="one-time-code" required value={regenerateForm.factor} onChange={event => regenerateForm.setFactor(event.target.value)} /></label>
          <button className="v2-button v2-button-secondary" disabled={busy}>Générer de nouveaux codes</button>
        </form>
        <form onSubmit={disable} className="v2-security-form">
          <h3>Désactiver la double authentification</h3>
          <p className="v2-settings-note">La désactivation révoque également tous vos jetons API.</p>
          <label>Mot de passe<input type="password" autoComplete="current-password" required value={disableForm.password} onChange={event => disableForm.setPassword(event.target.value)} /></label>
          <label>Code actuel ou de secours<input type="text" autoComplete="one-time-code" required value={disableForm.factor} onChange={event => disableForm.setFactor(event.target.value)} /></label>
          <button className="v2-button v2-button-secondary" disabled={busy}>Désactiver</button>
        </form>
      </> : <>
        <p><strong>Inactive</strong></p>
        <p className="v2-settings-note">{activationWarning(tokens.length)}</p>
        {!setup ? <form onSubmit={prepare} className="v2-security-form">
          <label>Confirmez votre mot de passe<input type="password" autoComplete="current-password" required value={setupForm.password} onChange={event => setupForm.setPassword(event.target.value)} /></label>
          <button className="v2-button v2-button-secondary" disabled={busy}>Configurer</button>
        </form> : <>
          <p>Saisissez cette clé dans une application compatible TOTP. La préparation expire au bout de 15 minutes.</p>
          <code className="v2-security-secret">{setup.secret}</code>
          <p className="v2-settings-note"><a href={setup.provisioning_uri}>Ouvrir dans une application d’authentification</a></p>
          <form onSubmit={confirm} className="v2-security-form">
            <label>Code à six chiffres<input type="text" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9]{6}" required value={confirmCode} onChange={event => setConfirmCode(event.target.value)} /></label>
            <button className="v2-button v2-button-primary" disabled={busy}>Activer</button>
          </form>
          <button type="button" className="v2-button v2-button-secondary" disabled={busy}
            onClick={() => { setSetup(null); setConfirmCode(""); setError(""); setNotice(""); }}>
            Recommencer la configuration
          </button>
        </>}
      </>}
      {codes.length > 0 && <div className="v2-security-once" role="status">
        <h3>Codes de secours — affichés une seule fois</h3>
        <p>Enregistrez-les dans un endroit sûr. Chaque code ne sert qu’une fois.</p>
        <ul>{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => setCodes([])}>J’ai enregistré ces codes</button>
      </div>}
    </section>
    <section className="v2-settings-card v2-account-security" aria-labelledby="v2-tokens-heading">
      <h2 id="v2-tokens-heading">Jetons API</h2>
      <p>Utilisez un jeton dans l’en-tête <code>Authorization: Bearer &lt;jeton&gt;</code> pour appeler l’API sans cookie. Il ne donne jamais accès à l’administration. <a href="/api/v2/docs">Documentation de l’API</a>.</p>
      <form onSubmit={createToken} className="v2-security-form">
        <label>Nom du jeton<input type="text" maxLength={80} required value={label} onChange={event => setLabel(event.target.value)} placeholder="Mon application" /></label>
        <label>Accès<select value={scope} onChange={event => setScope(event.target.value as "read" | "contribute")}>
          <option value="read">Lecture seule (inclut l’export de votre compte)</option><option value="contribute">Lecture et contribution</option>
        </select></label>
        <label>Expiration<select value={expiry} onChange={event => setExpiry(Number(event.target.value))}>
          <option value={30}>30 jours</option><option value={90}>90 jours</option><option value={365}>1 an</option>
        </select></label>
        <label>Mot de passe<input type="password" autoComplete="current-password" required value={tokenForm.password} onChange={event => tokenForm.setPassword(event.target.value)} /></label>
        {mfa?.enabled && <label>Code actuel ou de secours<input type="text" autoComplete="one-time-code" required value={tokenForm.factor} onChange={event => tokenForm.setFactor(event.target.value)} /></label>}
        <button className="v2-button v2-button-primary" disabled={busy || mfa === null}>Créer un jeton</button>
      </form>
      {createdToken && <div className="v2-security-once" role="status">
        <h3>Jeton — affiché une seule fois</h3>
        <code className="v2-security-secret">{createdToken}</code>
        <p>Conservez-le dans un gestionnaire de secrets. Ne le publiez pas et ne le collez pas dans un chat.</p>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => setCreatedToken("")}>J’ai enregistré ce jeton</button>
      </div>}
      <h3>Jetons actifs</h3>
      {tokens.length === 0 ? <p>Aucun jeton actif.</p> : <ul className="v2-security-tokens">{tokens.map(token =>
        <li key={token.id}><div><strong>{token.label}</strong><br /><small>{token.scope === "read" ? "Lecture" : "Contribution"} · expire le {date(token.expires_at)} · {token.last_used_at ? `utilisé le ${date(token.last_used_at)}` : "jamais utilisé"}</small></div>
          <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => revoke(token.id)}>Révoquer</button></li>
      )}</ul>}
    </section>
    {(error || notice) && <div className="v2-security-feedback" role={error ? "alert" : "status"}>{error || notice}</div>}
  </>;
}
