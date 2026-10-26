import { useState, type FormEvent } from "react";
import { V2_BASKET_EVENT } from "./v2-basket-storage";

async function clearDeletedAccountData(userId: number): Promise<boolean> {
  let complete = true;
  try {
    const id = String(userId);
    const prefixes = [
      `v2:product:new:${id}`, `v2:product:edit:${id}:`,
      `v2:product:draft:${id}:`, `v2:recipe:new:${id}`,
      `v2:recipe:edit:${id}:`,
    ];
    const exact = [
      `v2:basket:user:${id}`, `v2:basket:ops:${id}`,
      `v2:pwa:sync-attempt:${id}`, `v2:pwa:versions:${id}`,
      "v2:pwa:recipe-summaries", "v2:pwa:recipe-summaries-ready",
    ];
    for (const key of Object.keys(localStorage)) {
      if (exact.includes(key) || prefixes.some(prefix => key === prefix || key.startsWith(prefix))) {
        localStorage.removeItem(key);
      }
    }
    if (localStorage.getItem("v2:basket:active-user") === id) {
      localStorage.removeItem("v2:basket:active-user");
    }
    // Other tabs recheck the revoked session and discard stale UI state.
    localStorage.setItem("v2:account:deleted", String(Date.now()));
    window.dispatchEvent(new Event(V2_BASKET_EVENT));
  } catch { complete = false; }
  try {
    if ("caches" in window) await caches.delete("price-checker-offline-data-v2");
  } catch { complete = false; }
  return complete;
}

export default function V2AccountDeletion({ userId, onDeleted }: {
  userId: number; onDeleted: (localCleared: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || !confirmed || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v2/account", {
        method: "DELETE", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const detail = data && typeof data === "object" && "detail" in data
          ? (data as { detail: unknown }).detail : null;
        throw new Error(typeof detail === "string" ? detail : "La suppression a échoué.");
      }
      setPassword("");
      const cleared = await clearDeletedAccountData(userId);
      onDeleted(cleared);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "La suppression a échoué.");
    } finally { setBusy(false); }
  }

  return <section className="v2-settings-card v2-settings-danger" aria-labelledby="v2-delete-account-heading">
    <h2 id="v2-delete-account-heading">Supprimer mon compte</h2>
    <p>Les brouillons, le panier, les signalements personnels et toutes les sessions seront supprimés. Les produits, prix et recettes déjà publiés resteront visibles, sans votre pseudo. Exportez vos données avant si vous souhaitez les conserver.</p>
    {!open ? <button type="button" className="v2-button v2-button-secondary" onClick={() => setOpen(true)}>Préparer la suppression</button>
      : <form onSubmit={submit}>
        <label className="v2-settings-delete-field" htmlFor="v2-delete-password">Confirmer avec votre mot de passe
          <input id="v2-delete-password" type="password" autoComplete="current-password" required value={password}
            onChange={event => setPassword(event.target.value)} disabled={busy} />
        </label>
        <label className="v2-settings-delete-confirm"><input type="checkbox" checked={confirmed}
          onChange={event => setConfirmed(event.target.checked)} disabled={busy} /> Je comprends que cette suppression est définitive.</label>
        {error && <p className="v2-schedule-error" role="alert">{error}</p>}
        <div className="v2-settings-actions">
          <button type="submit" className="v2-button v2-button-secondary v2-settings-delete-button" disabled={busy || !confirmed || !password}>{busy ? "Suppression…" : "Supprimer définitivement mon compte"}</button>
          <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => { setOpen(false); setPassword(""); setConfirmed(false); setError(""); }}>Annuler</button>
        </div>
      </form>}
  </section>;
}
