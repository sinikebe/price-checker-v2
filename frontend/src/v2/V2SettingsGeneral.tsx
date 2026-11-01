import { Link } from "react-router-dom";
import { useV2Theme } from "./V2ThemeContext";
import { usePwaUpdate } from "../pwa/PwaUpdateState";
import versions from "./component-versions.json";

const updateMessages = {
  idle: "Vérifiez si une nouvelle version de l’application est disponible.",
  checking: "Recherche d’une mise à jour…",
  current: "L’application est à jour.",
  available: "Une nouvelle version est prête à être installée.",
  offline: "Connectez-vous à Internet pour rechercher une mise à jour.",
  unsupported: "La mise à jour automatique n’est pas disponible dans ce navigateur.",
  error: "La vérification a échoué. Réessayez plus tard.",
};

/** Settings that apply to this device, whoever is signed in: appearance and application updates. */
export default function V2SettingsGeneral() {
  const { choice, setChoice } = useV2Theme();
  const { checkState, checkForUpdates, applyUpdate } = usePwaUpdate();
  return <>
    <section className="v2-settings-card" aria-labelledby="v2-theme-heading">
      <h2 id="v2-theme-heading">Apparence</h2>
      <p>Choisissez le thème de cet appareil.</p>
      <fieldset className="v2-theme-options">
        <legend>Thème de l’application</legend>
        {([ ["system", "Système"], ["light", "Clair"], ["dark", "Sombre"] ] as const).map(([value, label]) =>
          <label key={value} className={choice === value ? "v2-theme-selected" : ""}>
            <input type="radio" name="v2-theme" value={value} checked={choice === value} onChange={() => setChoice(value)} />
            {label}
          </label>
        )}
      </fieldset>
    </section>
    <section className="v2-settings-card" aria-labelledby="v2-update-heading">
      <h2 id="v2-update-heading">Mises à jour</h2>
      <p>Version installée : <strong>{versions.application.version}</strong></p>
      <p className="v2-settings-status" role="status" aria-live="polite">{updateMessages[checkState]}</p>
      <div className="v2-settings-actions">
        <button type="button" className="v2-button v2-button-secondary" onClick={() => void checkForUpdates()} disabled={checkState === "checking"}>Vérifier les mises à jour</button>
        {checkState === "available" && <button type="button" className="v2-button v2-button-primary" onClick={() => void applyUpdate()}>Mettre à jour l’application</button>}
      </div>
      <p className="v2-settings-note">La mise à jour actualise l’application sur cet appareil, pas le serveur. Elle recharge cette page : terminez vos modifications en cours avant de continuer.</p>
      <Link className="v2-settings-link" to="/v2/versions">Détail des versions →</Link>
    </section>
  </>;
}
