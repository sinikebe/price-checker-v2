import { useState } from "react";
import V2Info from "./V2Info";
import { useConfirm } from "./useConfirm";
import { Link } from "react-router-dom";
import { reloadDemoSource, useDemoSource } from "./useDemoSource";
import { BUILTIN_DEMO_CONFIRM, DEMO_BASKET_PATH, demoDate } from "./v2-basket-demo";
import type { BasketItem } from "./v2-basket-storage";
import { removeDemoBasket, saveDemoBasket } from "./v2-demo-basket-api";
import type { SharedSettings } from "./v2-shared-basket";
import { errorText } from "./v2-http";

/**
 * For administrators, in the share panel of a basket: make it the demo basket of the home page, with its
 * settings and the prices the server reads at that moment, or go back to the app's own example.
 */
export default function V2DemoBasketSave({ items, settings }: { items: BasketItem[]; settings: Omit<SharedSettings, "checked"> }) {
  const confirm = useConfirm();
  const source = useDemoSource();
  const [title, setTitle] = useState(() => source && !source.fictional ? source.title : "Un mois de courses");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const saved = source && !source.fictional ? source : null;
  async function run(action: () => Promise<string>) {
    setBusy(true); setMessage(null);
    try { setMessage({ error: false, text: await action() }); reloadDemoSource(); }
    catch (reason) { setMessage({ error: true, text: errorText(reason, "Échec. Réessayez.") }); }
    finally { setBusy(false); }
  }
  return <section className="v2-demo-save" aria-labelledby="v2-demo-save-heading">
    <h3 id="v2-demo-save-heading">Panier de démonstration <V2Info>Réservé aux administrateurs. Ce panier devient l’exemple de l’accueil : ses articles, leurs quantités et ses réglages,
      avec les prix que le serveur relit maintenant. Tout le monde pourra le voir et le manipuler, sans compte ni crédit, jusqu’au prochain remplacement.</V2Info></h3>
    <p className="v2-shared-hint">{saved ? `Actuellement : «\u00a0${saved.title}\u00a0», enregistré le ${demoDate(saved.savedAt)}.` : "Actuellement : l’exemple intégré, avec des prix fictifs."}{" "}
      <Link to={DEMO_BASKET_PATH}>Voir la démonstration</Link></p>
    <form className="v2-demo-save-form" onSubmit={async event => {
      event.preventDefault();
      if (busy || !title.trim()) return;
      if (!await confirm({ title: "Panier de démonstration", message: `Remplacer le panier de démonstration de l’accueil par ce panier (${items.length} article${items.length > 1 ? "s" : ""}) ?\n\nSes prix actuels seront visibles par tous, sans crédit.`, confirmLabel: "Remplacer la démonstration" })) return;
      void run(async () => {
        const result = await saveDemoBasket(title.trim(), items, settings);
        return `Panier de démonstration enregistré : ${result.items} article${result.items > 1 ? "s" : ""}, ${result.products} produit${result.products > 1 ? "s" : ""} comparé${result.products > 1 ? "s" : ""}.`;
      });
    }}>
      <label>Titre sur l’accueil<input value={title} maxLength={80} required onChange={event => setTitle(event.target.value)} /></label>
      <small>Affiché ainsi : «&nbsp;{title.trim() || "…"}, du panier à la liste.&nbsp;»</small>
      <div className="v2-demo-save-actions">
        <button type="submit" className="v2-button v2-button-primary" disabled={busy || !title.trim() || !items.length || items.length > 100}>
          {busy ? "Enregistrement…" : "Utiliser ce panier comme démonstration"}</button>
        {saved && <button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={async () => {
          if (await confirm(BUILTIN_DEMO_CONFIRM))
            void run(async () => { await removeDemoBasket(); return "L’accueil montre de nouveau l’exemple intégré."; });
        }}>Revenir à l’exemple intégré</button>}
      </div>
    </form>
    {message && <p role={message.error ? "alert" : "status"} className={message.error ? "v2-recipes-error" : undefined}>{message.text}</p>}
  </section>;
}
