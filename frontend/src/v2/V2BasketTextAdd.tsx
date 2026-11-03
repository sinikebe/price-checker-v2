import { useContext, useState } from "react";
import { BasketReadOnlyContext, readOnlyTitle } from "./v2-basket-read-only";
import { FREE_TEXT_MAX } from "./v2-basket-storage";

/**
 * Add free text to a basket: an article not in the catalogue yet, kept for the list and replaced later
 * by a product, a group or an ensemble. `onAdd` answers with a message when the text cannot be added.
 */
export default function V2BasketTextAdd({ onAdd }: { onAdd: (name: string) => string | null }) {
  const readOnly = useContext(BasketReadOnlyContext);
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const name = text.replace(/\s+/g, " ").trim();
  return <form className="v2-basket-text-add" onSubmit={event => {
    event.preventDefault();
    if (!name || readOnly) return;
    const refused = onAdd(name);
    setMessage(refused ?? `« ${name} » ajouté au panier, à compléter plus tard.`);
    if (!refused) setText("");
  }}>
    <label>Ajouter un texte libre
      <span className="v2-basket-text-add-row">
        <input value={text} maxLength={FREE_TEXT_MAX} placeholder="Ex. : sauce tomate de la marque du magasin" disabled={!!readOnly}
          onChange={event => { setText(event.target.value); setMessage(""); }} />
        <button type="submit" className="v2-button v2-button-secondary" disabled={!name || !!readOnly} title={readOnly ? readOnlyTitle(readOnly) : undefined}>Ajouter</button>
      </span>
    </label>
    <small>Pour un article pas encore au catalogue : il figure dans la liste de courses, sans prix, et se remplace ensuite par un produit, un groupe ou un ensemble.</small>
    {message && <p role="status">{message}</p>}
  </form>;
}
