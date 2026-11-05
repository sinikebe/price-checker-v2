import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import LevelBadge from "./V2LevelBadge";
import { ArrowRightIcon } from "./V2SiteIcons";
import { CATALOGUE_DEMO, CATALOGUE_DEMO_ID, centsPerKg, demoRanking, type DemoLevel } from "./v2-catalogue-demo";
import { money } from "./v2-basket-view";
import "./v2-catalogue-demo.css";

const perKg = (cents: number) => `${money(cents)}/kg`;

/**
 * How the catalogue is arranged, on one fictional branch: department, family, ensemble, comparable
 * groups and three products. Comparing the group or the whole ensemble shows which product wins.
 */
export default function V2CatalogueDemo() {
  const [level, setLevel] = useState<DemoLevel>("group");
  const root = useRef<HTMLElement>(null);
  const demo = CATALOGUE_DEMO;
  const group = demo.groups[0];
  const ranking = demoRanking(level);
  const best = ranking[0];
  const compared = new Set(ranking.map(product => product.id));
  // Reached from a link elsewhere in the app (the catalogue page): bring the example into view, again
  // while the sections above it finish loading, unless the reader has started scrolling.
  useEffect(() => {
    if (window.location.hash !== "#" + CATALOGUE_DEMO_ID) return;
    let moved = false;
    const stop = () => { moved = true; };
    const events = ["wheel", "touchstart", "keydown"] as const;
    for (const name of events) window.addEventListener(name, stop, { passive: true });
    const timers = [0, 300, 800, 1500].map(delay => window.setTimeout(() => {
      if (!moved) root.current?.scrollIntoView({ block: "start" });
    }, delay));
    return () => {
      timers.forEach(window.clearTimeout);
      for (const name of events) window.removeEventListener(name, stop);
    };
  }, []);
  return <section ref={root} className="v2-catalogue-demo v2-wrap" id={CATALOGUE_DEMO_ID} aria-labelledby="v2-catalogue-demo-heading">
    <div className="v2-section-heading">
      <div>
        <span className="v2-section-kicker">LE CATALOGUE</span>
        <h2 id="v2-catalogue-demo-heading">Du rayon au produit, ce qui se compare.</h2>
      </div>
      <p>Un exemple avec trois produits, des marques, des magasins et des prix fictifs.</p>
    </div>

    <div className="v2-catalogue-demo-grid">
      <div className="v2-catalogue-demo-tree" role="group" aria-label="Exemple d’arborescence du catalogue">
        <ul>
          <li><LevelBadge level="department" /><strong>{demo.department}</strong>
            <ul><li><LevelBadge level="family" /><strong>{demo.family}</strong>
              <ul><li data-active={level === "scope"}><LevelBadge level="scope" /><strong>{demo.scope}</strong>
                <ul>{demo.groups.map(item => <li key={item.name} data-active={level === "scope" || item.name === group.name}>
                  <LevelBadge level="group" /><strong>{item.name}</strong>
                  <ul>{item.products.map(product => <li key={product.id} className="v2-catalogue-demo-product"
                    data-compared={compared.has(product.id)} data-best={product.id === best.id}>
                    <LevelBadge level="product" />
                    <span className="v2-catalogue-demo-name"><strong>{product.name}</strong><small>{product.brand} · {product.quantity}</small></span>
                    <span className="v2-catalogue-demo-price"><strong>{money(product.cents)}</strong><small>{perKg(centsPerKg(product))} · {product.store}</small></span>
                  </li>)}</ul>
                </li>)}</ul>
              </li></ul>
            </li></ul>
          </li>
        </ul>
      </div>

      <div className="v2-catalogue-demo-compare">
        <div className="v2-catalogue-demo-switch" role="group" aria-label="Niveau comparé">
          <button type="button" aria-pressed={level === "group"} onClick={() => setLevel("group")}>Le groupe « {group.name} »</button>
          <button type="button" aria-pressed={level === "scope"} onClick={() => setLevel("scope")}>L’ensemble « {demo.scope} »</button>
        </div>
        <p className="v2-catalogue-demo-lead" aria-live="polite">{level === "group"
          ? `Je veux des ${group.name.toLowerCase()} : les deux formats se comparent au kilo, et le paquet de ${best.quantity} (${best.brand}) passe devant.`
          : `N’importe quelles ${demo.scope.toLowerCase()} me conviennent : les ${best.name.toLowerCase()} (${best.brand}) passent devant.`}</p>
        <ol className="v2-catalogue-demo-ranking">{ranking.map((product, index) => <li key={product.id} data-best={index === 0}>
          <span className="v2-catalogue-demo-name"><strong>{product.name}</strong><small>{product.brand} · {product.quantity} · {product.store}</small></span>
          <strong>{perKg(centsPerKg(product))}</strong>
        </li>)}</ol>
        <p className="v2-catalogue-demo-note">Un produit, un groupe ou un ensemble s’ajoute tel quel au panier : le panier retient le moins cher de ce que vous acceptez.</p>
        <Link className="v2-button v2-button-secondary" to="/v2/produits">Parcourir le catalogue <ArrowRightIcon /></Link>
      </div>
    </div>
  </section>;
}
