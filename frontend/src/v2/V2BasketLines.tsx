import { useContext } from "react";
import V2BasketLink from "./V2BasketLink";
import { BasketReadOnlyContext } from "./v2-basket-read-only";
import { pricePosition, type PriceChoice } from "./v2-basket-comparison";
import { basketItemKey, type BasketItem } from "./v2-basket-storage";
import type { BaseUnit } from "./v2-basket-quantity";
import { basketQuantityLabel } from "./v2-basket-share-labels";
import { freshness, itemHref, itemName, money, productName, shortDate, surplusText, unitName, unitPriceText } from "./v2-basket-view";

/** Switches the unit an article is compared in, when its products are measured in several (per kg, per piece). */
function UnitSwitch({ choice, onUnit }: { choice: PriceChoice; onUnit: (item: BasketItem, unit: BaseUnit) => void }) {
  const unit = choice.unit;
  const readOnly = !!useContext(BasketReadOnlyContext);
  if (!unit || unit.fixed || unit.available.length < 2) return null;
  return <span className="v2-basket-unit-switch" role="group" aria-label={`Unité de comparaison pour ${itemName(choice.item)}`}>
    {unit.available.map(option => <button type="button" key={option} aria-pressed={option === unit.unit} disabled={readOnly}
      title={`Comparer au prix ${option === "piece" ? "à la" : "au"} ${unitName(option)}`}
      onClick={() => { if (option !== unit.unit) onUnit(choice.item, option); }}>{unitName(option)}</button>)}
  </span>;
}

function DatedPrice({ choice, range, onUnit }: { choice: PriceChoice; range: { min: number; max: number }; onUnit: (item: BasketItem, unit: BaseUnit) => void }) {
  const age = freshness(choice.reading.observed_at);
  const position = pricePosition(choice.cents, range.min, range.max);
  const positionLabel = { low: "prix bas", middle: "prix intermédiaire", high: "prix haut", neutral: "prix identique ou seul" }[position];
  return <span className="v2-basket-reading" data-price-position={position}>
    <strong title={positionLabel} aria-label={money(choice.cents) + " · " + positionLabel}>{money(choice.cents)}</strong>
    {choice.packages > 1 && <small>{choice.packages} paquets à acheter</small>}
    {choice.unit && <small className="v2-basket-unit-price">{unitPriceText(choice.unit)}</small>}
    <UnitSwitch choice={choice} onUnit={onUnit} />
    {choice.used && <small>Part utilisée : {money(choice.usedCents)}</small>}
    {choice.unit && surplusText(choice.unit) && <small className="v2-basket-surplus">{surplusText(choice.unit)}</small>}
    <span className="v2-basket-age" data-age={age.code} title={age.label}><span className="v2-site-sr-only">Fraîcheur : {age.label}</span></span>
    <small>Relevé du {shortDate(choice.reading.observed_at)}</small>
  </span>;
}

function ChoiceLabel({ choice, advanced }: { choice: PriceChoice; advanced: boolean }) {
  return <span className="v2-basket-choice"><V2BasketLink to={itemHref(choice.item)}>{itemName(choice.item)}</V2BasketLink>
    {advanced && choice.item.quantity && <small>Demandé : {basketQuantityLabel(choice.item.quantity)}</small>}
    {!("kind" in choice.item) && choice.product.id !== choice.item.id && <small>Référence actuelle : <V2BasketLink to={"/v2/produits/" + choice.product.id}>{productName(choice.product)}</V2BasketLink></small>}
    {"kind" in choice.item && <small>Choix : <V2BasketLink to={"/v2/produits/" + choice.product.id}>{productName(choice.product)}</V2BasketLink>
      {choice.product.data.quantity && " · " + choice.product.data.quantity}</small>}</span>;
}

/** The priced lines of one store, each with its price. */
export default function V2BasketLines({ choices, advanced, rangeFor, onUnit }: {
  choices: PriceChoice[]; advanced: boolean; rangeFor: (choice: PriceChoice) => { min: number; max: number };
  onUnit: (item: BasketItem, unit: BaseUnit) => void;
}) {
  return <ul className="v2-basket-lines">{choices.map(choice => <li key={basketItemKey(choice.item)}>
    <ChoiceLabel choice={choice} advanced={advanced} /><DatedPrice choice={choice} range={rangeFor(choice)} onUnit={onUnit} /></li>)}</ul>;
}
