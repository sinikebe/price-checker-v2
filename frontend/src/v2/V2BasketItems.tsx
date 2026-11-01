import { useState } from "react";
import { Link } from "react-router-dom";
import { basketItemKey, validBasketQuantity, type BasketItem, type BasketQuantity } from "./v2-basket-storage";
import { alternatives, itemHref, itemKind, itemName, type Category } from "./v2-basket-view";

function QuantityEditor({ item, onChange }: { item: BasketItem; onChange: (value: BasketQuantity) => void }) {
  const initial = item.quantity ?? { amount: "1", unit: "package" as const };
  const [amount, setAmount] = useState(initial.amount);
  const [unit, setUnit] = useState<BasketQuantity["unit"]>(initial.unit);
  const [error, setError] = useState(false);
  function save(nextAmount: string, nextUnit: BasketQuantity["unit"]) {
    const value = { amount: nextAmount, unit: nextUnit };
    if (!validBasketQuantity(value)) { setError(true); return; }
    setError(false); onChange(value);
  }
  return <div className="v2-basket-quantity"><label>Quantité demandée<input aria-label={`Quantité demandée pour ${itemName(item)}`} type="number" min="0.000001" max="999999" step="any" value={amount} onChange={event => { setAmount(event.target.value); setError(false); }} /></label>
    <label>Unité<select aria-label={`Unité pour ${itemName(item)}`} value={unit} onChange={event => setUnit(event.target.value as BasketQuantity["unit"])}>
      <option value="package">paquet(s)</option><option value="g">g</option><option value="kg">kg</option><option value="ml">ml</option><option value="cl">cl</option><option value="l">l</option><option value="piece">pièce(s)</option>
    </select></label><button type="button" className="v2-button v2-button-secondary" onClick={() => save(amount, unit)}>Appliquer</button>
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
export default function V2BasketItems({ items, advanced, categories, categoryError, actions }: {
  items: BasketItem[]; advanced: boolean; categories: Category[] | null; categoryError: boolean; actions: Actions;
}) {
  return <section className="v2-basket-panel" id="v2-basket-panel-items" aria-label="Articles du panier">
    <p>Un groupe ou un ensemble compte pour un article.{advanced ? " Indiquez la quantité voulue : le total couvre des paquets entiers, la part utilisée est calculée au prorata." : ""}</p>
    <ul className="v2-basket-editor-list">{items.map(item => {
      const itemKey = basketItemKey(item);
      const choices = alternatives(item, categories ?? []);
      return <li className="v2-basket-editor-item" data-disabled={item.disabled ? "true" : "false"} key={itemKey}>
        <div className="v2-basket-editor-main"><div><span className="v2-basket-item-kind">{itemKind(item)}</span><Link to={itemHref(item)}>{itemName(item)}</Link>
          {!("kind" in item) && <small>{item.data.quantity || "Quantité non précisée"}</small>}</div>
          <label className="v2-basket-toggle"><input type="checkbox" checked={!item.disabled} onChange={event => actions.setEnabled(item, event.target.checked)} />Inclure</label></div>
        <div className="v2-basket-editor-controls">
          {choices.length > 1 && <label>Choix de comparaison
            <select value={itemKey} onChange={event => { const selected = choices.find(choice => basketItemKey(choice) === event.target.value); if (selected) actions.replace(item, selected); }}>
              {choices.map(choice => <option key={basketItemKey(choice)} value={basketItemKey(choice)} disabled={basketItemKey(choice) !== itemKey && items.some(saved => basketItemKey(saved) === basketItemKey(choice))}>{itemKind(choice)} · {choice.name}</option>)}
            </select></label>}
          {"kind" in item && categoryError && <small>Autres choix indisponibles hors ligne.</small>}
          <button type="button" className="v2-basket-remove" onClick={() => actions.remove(item)}>Retirer</button>
        </div>
        {advanced && <QuantityEditor key={`${itemKey}:${item.quantity?.amount}:${item.quantity?.unit}`} item={item} onChange={quantity => actions.setQuantity(item, quantity)} />}
      </li>;
    })}</ul>
    <button type="button" className="v2-button v2-button-secondary v2-basket-clear" onClick={() => { if (window.confirm("Vider le panier ?")) actions.clear(); }}>Vider le panier</button>
  </section>;
}
