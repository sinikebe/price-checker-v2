import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import "./v2-home.css";
import "./v2-setup.css";
import "./v2-auth.css";

import { authRequest, type V2User } from "./v2-auth-api";
type Mode = "admin" | "login" | "register";

export default function V2AuthPage({
  mode, environment, onAuthenticated,
}: {
  mode: Mode;
  environment: string;
  onAuthenticated: (user: V2User) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const previous = document.title;
    document.title = (mode === "admin" ? "Initialisation" : mode === "register" ? "Créer un compte" : "Connexion") + " | Price Checker";
    return () => { document.title = previous; };
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (mode !== "login" && password !== confirmation) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    setBusy(true);
    try {
      const user = await authRequest<V2User>(
        mode === "admin" ? "admin" : mode === "register" ? "register" : "login",
        "POST",
        mode === "admin" ? { access_code: accessCode, password } : { username, password },
      );
      setPassword("");
      setConfirmation("");
      setAccessCode("");
      onAuthenticated(user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "L'opération a échoué.");
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = mode === "admin";
  const isRegister = mode === "register";
  const passwordMinimum = isAdmin && environment === "dev" ? 8 : 12;
  return (
    <div className="v2-home v2-setup v2-auth">
      <a className="v2-skip" href="#v2-auth-main">Aller au contenu</a>
      <header className="v2-header">
        <div className="v2-wrap v2-header-inner">
          <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
            <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
            <span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
          </Link>
          <span className="v2-setup-header-label">{isAdmin ? "Premier démarrage" : "Votre espace"}</span>
        </div>
      </header>
      <main id="v2-auth-main" className="v2-wrap v2-auth-main">
        <div className="v2-auth-copy">
          <span className="v2-section-kicker">{isAdmin ? "ÉTAPE 02 · ADMINISTRATEUR" : "BIENVENUE"}</span>
          <h1>{isAdmin ? <>Sécurisons votre <em>espace.</em></> : isRegister ? <>Un espace à <em>vous.</em></> : <>Content de vous <em>retrouver.</em></>}</h1>
          <p>{isAdmin
            ? "La base V2 est prête. Choisissez maintenant le mot de passe du compte administrateur. Le code d'installation reste nécessaire pour cette première opération."
            : isRegister
              ? "Un pseudo et un mot de passe suffisent. Aucun e-mail n'est demandé."
              : "Connectez-vous avec votre pseudo et votre mot de passe."}</p>
        </div>
        <div className="v2-auth-layout">
          <form className="v2-setup-card v2-auth-card" onSubmit={submit}>
            <h2>{isAdmin ? "Créer l'administrateur" : isRegister ? "Créer mon compte" : "Me connecter"}</h2>
            {isAdmin ? (
              <div className="v2-auth-admin-name"><span>Pseudo administrateur</span><strong>admin</strong></div>
            ) : (
              <div className="v2-setup-field">
                <label htmlFor="v2-username">Pseudo</label>
                <input id="v2-username" type="text" autoComplete="username" autoCapitalize="off"
                  spellCheck={false} minLength={3} maxLength={32} required value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Votre pseudo" />
                {isRegister && <small>3 à 32 caractères : lettres, chiffres, point, tiret ou underscore. Ce pseudo apparaîtra avec vos recettes et contributions publiques : n’y mettez pas d’information personnelle.</small>}
              </div>
            )}
            {isAdmin && (
              <div className="v2-setup-field">
                <label htmlFor="v2-install-code">Code d'installation du serveur</label>
                <input id="v2-install-code" type="password" autoComplete="off" required value={accessCode}
                  onChange={(event) => setAccessCode(event.target.value)} />
              </div>
            )}
            <div className="v2-setup-field">
              <label htmlFor="v2-account-password">Mot de passe</label>
              <input id="v2-account-password" type="password"
                autoComplete={isAdmin || isRegister ? "new-password" : "current-password"}
                minLength={isAdmin || isRegister ? passwordMinimum : undefined}
                required value={password} onChange={(event) => setPassword(event.target.value)} />
              {mode !== "login" && <small>{passwordMinimum} caractères minimum.</small>}
            </div>
            {mode !== "login" && (
              <div className="v2-setup-field">
                <label htmlFor="v2-account-confirm">Confirmer le mot de passe</label>
                <input id="v2-account-confirm" type="password" autoComplete="new-password"
                  required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
              </div>
            )}
            {error && <p className="v2-setup-message v2-setup-error" role="alert">{error}</p>}
            <button className="v2-setup-primary" disabled={busy}>
              {busy ? "Un instant…" : isAdmin ? "Créer l'administrateur" : isRegister ? "Créer mon compte" : "Me connecter"}
            </button>
            {!isAdmin && <p className="v2-auth-switch">{isRegister
              ? <>Déjà un compte ? <Link to="/v2/connexion">Se connecter</Link></>
              : <>Pas encore de compte ? <Link to="/v2/inscription">Créer un compte</Link></>}</p>}
          </form>
          <aside className="v2-setup-aside v2-auth-aside">
            <div className="v2-setup-aside-icon" aria-hidden="true">✦</div>
            <h2>{isAdmin ? "Une première étape importante." : "Simple et personnel."}</h2>
            <p>{isAdmin
              ? "Le mot de passe est haché avant son stockage. Il ne sera jamais renvoyé par l'API."
              : "Votre compte est personnel. Les permissions de contribution viendront après validation."}</p>
            <div className="v2-setup-aside-rule" />
            <div className="v2-setup-aside-point"><span>✓</span><p>Aucun e-mail requis</p></div>
            <div className="v2-setup-aside-point"><span>✓</span><p>Session sécurisée côté serveur</p></div>
            <div className="v2-setup-aside-point"><span>✓</span><p>Panier conservé dans ce navigateur</p></div>
          </aside>
        </div>
        {!isAdmin && <Link className="v2-auth-back" to="/v2">← Retour à l'accueil</Link>}
      </main>
    </div>
  );
}
