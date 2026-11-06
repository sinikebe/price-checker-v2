import { useState, type FormEvent } from "react";
import {
  PWA_CACHE_GENERATION_KEY, PWA_CACHE_NAME, PWA_PREVIOUS_CACHE_NAME,
  PWA_RECIPES_KEY, PWA_RECIPES_READY_KEY, PWA_SYNC_ATTEMPT_KEY,
  PWA_VERSIONS_KEY,
} from "../pwa/cache-keys";
import { V2_BASKET_EVENT, forgetActiveBasketUser } from "./v2-basket-storage";
import { accountLocalKeys } from "./v2-account-local-keys";
import { ACCOUNT_DELETED_KEY } from "./v2-account-session";
import { requestJson } from "./v2-http";

async function clearDeletedAccountData(userId: number): Promise<boolean> {
  let complete = true;
  try {
    const id = String(userId);
    const exact = [
      `${PWA_SYNC_ATTEMPT_KEY}:${id}`, `${PWA_VERSIONS_KEY}:${id}`,
      PWA_RECIPES_KEY, PWA_RECIPES_READY_KEY,
      PWA_CACHE_GENERATION_KEY,
    ];
    for (const key of accountLocalKeys(Object.keys(localStorage), userId, exact)) localStorage.removeItem(key);
    forgetActiveBasketUser(userId);
    // Other tabs recheck the revoked session and discard stale UI state.
    localStorage.setItem(ACCOUNT_DELETED_KEY, String(Date.now()));
    window.dispatchEvent(new Event(V2_BASKET_EVENT));
  } catch { complete = false; }
  try {
    if ("caches" in window) await Promise.all([caches.delete(PWA_PREVIOUS_CACHE_NAME), caches.delete(PWA_CACHE_NAME)]);
  } catch { complete = false; }
  return complete;
}

export default function V2AccountDeletion({ userId, onDeleted }: {
  userId: number; onDeleted: (localCleared: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [secondFactor, setSecondFactor] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || !confirmed || busy) return;
    setBusy(true); setError("");
    try {
      await requestJson<void>("/api/v2/account", { method: "DELETE",
        body: { password, second_factor: secondFactor || null }, fallback: "La suppression a échoué." });
      setPassword(""); setSecondFactor("");
      const cleared = await clearDeletedAccountData(userId);
      onDeleted(cleared);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "La suppression a échoué.");
    } finally { setBusy(false); }
  }

  return <section className="v2-settings-card v2-settings-danger" aria-labelledby="v2-delete-account-heading">
    <h2 id="v2-delete-account-heading">Supprimer mon compte</h2>
    <p>Les brouillons, le panier local de ce navigateur, les signalements personnels et toutes les sessions seront supprimés. Les produits, prix et recettes déjà publiés resteront visibles, sans votre pseudo. Exportez vos données avant si vous souhaitez les conserver.</p>
    {!open ? <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen(true)}>Préparer la suppression</button>
      : <form onSubmit={submit}>
        <label className="v2-settings-delete-field" htmlFor="v2-delete-password">Confirmer avec votre mot de passe
          <input id="v2-delete-password" type="password" autoComplete="current-password" required value={password}
            onChange={event => setPassword(event.target.value)} disabled={busy} />
        </label>
        <label className="v2-settings-delete-field" htmlFor="v2-delete-factor">Code de validation ou de secours, si activé
          <input id="v2-delete-factor" type="text" autoComplete="one-time-code" value={secondFactor}
            onChange={event => setSecondFactor(event.target.value)} disabled={busy} />
        </label>
        <label className="v2-settings-delete-confirm"><input type="checkbox" checked={confirmed}
          onChange={event => setConfirmed(event.target.checked)} disabled={busy} /> Je comprends que cette suppression est définitive.</label>
        {error && <p className="v2-schedule-error" role="alert">{error}</p>}
        <div className="v2-settings-actions">
          <button type="submit" className="v2-button v2-button-secondary v2-settings-delete-button" disabled={busy || !confirmed || !password}>{busy ? "Suppression…" : "Supprimer définitivement mon compte"}</button>
          <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => { setOpen(false); setPassword(""); setSecondFactor(""); setConfirmed(false); setError(""); }}>Annuler</button>
        </div>
      </form>}
  </section>;
}
