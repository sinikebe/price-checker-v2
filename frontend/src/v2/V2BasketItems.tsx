import { useContext, useMemo, useState } from "react";
import { useConfirm } from "./useConfirm";
import V2BasketLink from "./V2BasketLink";
import V2BasketReplace from "./V2BasketReplace";
import V2BasketTextAdd from "./V2BasketTextAdd";
import { BasketReadOnlyContext } from "./v2-basket-read-only";
import { basketItemKey, isFreeText, validBasketQuantity, type BasketItem, type BasketQuantity } from "./v2-basket-storage";
import { alternativesIndex, itemHref, itemKind, itemName, selectionSummary, type Category } from "./v2-basket-view";

function QuantityEditor({ item, onChange }: { item: BasketItem; onChange: (value: BasketQuantity) => void }) {
  const readOnly = !!useContext(BasketReadOnlyContext);
  const initial = item.quantity ?? { amount: "1", unit: "package" as const };
  const [amount, setAmount] = useState(initial.amount);
  const [unit, setUnit] = useState<BasketQuantity["unit"]>(initial.unit);
  const [error, setError] = useState(false);
  function save(nextAmount: string, nextUnit: BasketQuantity["unit"]) {
    const value = { amount: nextAmount, unit: nextUnit };
    if (!validBasketQuantity(value)) { setError(true); return; }
    setError(false); onChange(value);
  }
  return <div className="v2-basket-quantity"><label>Quantité demandée<input aria-label={`Quantité demandée pour ${itemName(item)}`} type="number" min="0.000001" max="999999" step="any" value={amount} disabled={readOnly} onChange={event => { setAmount(event.target.value); setError(false); }} /></label>
    <label>Unité<select aria-label={`Unité pour ${itemName(item)}`} value={unit} disabled={readOnly} onChange={event => setUnit(event.target.value as BasketQuantity["unit"])}>
      <option value="package">paquet(s)</option><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="cl">cl</option><option value="l">l</option><option value="piece">pièce(s)</option>
    </select></label><button type="button" className="v2-button v2-button-secondary" disabled={readOnly} onClick={() => save(amount, unit)}>Appliquer</button>
    {error && <small role="alert">Quantité positive requise (6 décimales maximum).</small>}</div>;
}

type Actions = {
  setEnabled: (item: BasketItem, enabled: boolean) => void;
  setQuantity: (item: BasketItem, quantity: BasketQuantity | undefined) => void;
  replace: (item: BasketItem, next: BasketItem) => void;
  remove: (item: BasketItem) => void;
  clear: () => void;
};

/** The articles of the basket: include, compare as, quantity, remove. */
export default function V2BasketItems({ items, advanced, categories, categoryError, actions, addedBy, sharedName, onAddText }: {
  items: BasketItem[]; advanced: boolean; categories: Category[] | null; categoryError: boolean; actions: Actions;
  /** In a shared basket: who added each line. */
  addedBy?: (item: BasketItem) => string | null; sharedName?: string;
  /** Add free text to the basket; absent where the basket has no free text (the demo). */
  onAddText?: (name: string) => string | null;
}) {
  const confirm = useConfirm();
  const readOnly = !!useContext(BasketReadOnlyContext);
  // The free text line whose replacement is being chosen.
  const [replacing, setReplacing] = useState<string | null>(null);
  const choicesOf = useMemo(() => alternativesIndex(categories ?? []), [categories]);
  const keys = new Set(items.map(basketItemKey));
  return <section className="v2-basket-panel" id="v2-basket-panel-items" aria-label="Articles du panier">
    {readOnly && <p className="v2-basket-offline-note">Hors connexion : les articles se modifient au retour de la connexion.</p>}
    {onAddText && <V2BasketTextAdd onAdd={onAddText} />}
    <p>Un groupe ou un ensemble compte pour un article.{advanced ? " Indiquez la quantité voulue : le total couvre des paquets entiers, la part utilisée est calculée au prorata." : ""}</p>
    <ul className="v2-basket-editor-list">{items.map(item => {
      const itemKey = basketItemKey(item);
      const choices = choicesOf(item);
      return <li className="v2-basket-editor-item" data-disabled={item.disabled ? "true" : "false"} key={itemKey}>
        <div className="v2-basket-editor-main"><div><span className="v2-basket-item-kind">{itemKind(item)}</span>{isFreeText(item)
          ? <span className="v2-basket-unlinked">{item.name}</span> : <V2BasketLink to={itemHref(item)}>{itemName(item)}</V2BasketLink>}
          {!("kind" in item) && <small>{item.data.quantity || "Quantité non précisée"}</small>}
          {"kind" in item && item.kind === "selection" && <small className="v2-basket-selection">{selectionSummary(item)}</small>}
          {addedBy?.(item) && <small className="v2-basket-added-by">Ajouté par {addedBy(item)}</small>}</div>
          <label className="v2-basket-toggle"><input type="checkbox" checked={!item.disabled} disabled={readOnly} onChange={event => actions.setEnabled(item, event.target.checked)} />Inclure</label></div>
        <div className="v2-basket-editor-controls">
          {choices.length > 1 && <label>Choix de comparaison
            <select value={itemKey} disabled={readOnly} onChange={event => { const selected = choices.find(choice => basketItemKey(choice) === event.target.value); if (selected) actions.replace(item, selected); }}>
              {choices.map(choice => <option key={basketItemKey(choice)} value={basketItemKey(choice)} disabled={basketItemKey(choice) !== itemKey && items.some(saved => basketItemKey(saved) === basketItemKey(choice))}>{itemKind(choice)} · {choice.name}</option>)}
            </select></label>}
          {"kind" in item && categoryError && <small>Autres choix indisponibles hors ligne.</small>}
          {isFreeText(item) && <button type="button" className="v2-button v2-button-secondary v2-basket-replace-open" disabled={readOnly}
            aria-expanded={replacing === itemKey} onClick={() => setReplacing(replacing === itemKey ? null : itemKey)}>Remplacer par un produit, un groupe ou un ensemble</button>}
          <button type="button" className="v2-basket-remove" disabled={readOnly} onClick={() => actions.remove(item)}>Retirer</button>
        </div>
        {isFreeText(item) && replacing === itemKey && !readOnly && <V2BasketReplace item={item} taken={keys}
          onPick={next => { actions.replace(item, next); setReplacing(null); }} onClose={() => setReplacing(null)} />}
        {advanced && <QuantityEditor key={`${itemKey}:${item.quantity?.amount}:${item.quantity?.unit}`} item={item} onChange={quantity => actions.setQuantity(item, quantity)} />}
      </li>;
    })}</ul>
    <button type="button" className="v2-button v2-button-secondary v2-basket-clear" disabled={readOnly} onClick={async () => { if (await confirm({ title: "Vider le panier", message: sharedName ? `Vider « ${sharedName} » pour tous ses membres ?` : "Vider le panier ? Tous ses articles seront retirés.", confirmLabel: "Vider", danger: true })) actions.clear(); }}>Vider le panier</button>
  </section>;
}
