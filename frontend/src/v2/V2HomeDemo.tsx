import { Link } from "react-router-dom";
import { ArrowRightIcon, CartIcon } from "./V2SiteIcons";
import { useDemoSource } from "./useDemoSource";
import { DEMO_BASKET_PATH, demoDate } from "./v2-basket-demo";
import { demoStoryOf } from "./v2-basket-demo-story";
import { money } from "./v2-basket-view";
import "./v2-basket-demo.css";

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? "s" : ""}`;

/**
 * The demo story of the home page: a basket told in four steps, then the basket it ends on, and the way
 * into the demo basket. Every figure comes from the demo basket (the one an administrator saved, or the
 * app's fictional example), through the basket comparison.
 */
export default function V2HomeDemo() {
  const source = useDemoSource();
  const story = source ? demoStoryOf(source) : null;
  if (!story) return null;
  const { best, split, left, final } = story;
  const count = story.articles.length;
  const saving = best ? best.cents - final.cents : 0;
  const percent = best ? Math.round(100 * saving / best.cents) : 0;
  const complete = story.ranking.filter(store => store.complete);
  const shown = [...complete, ...story.ranking.filter(store => !store.complete).slice(0, complete.length ? 1 : 4)].slice(0, 4);
  const widest = Math.max(1, ...shown.map(store => store.cents));
  const prices = story.fictional ? "prix fictifs" : `prix du ${demoDate(story.savedAt)}`;
  const lead = story.mode === "unit" ? "le mieux placé au prix à l’unité" : "le moins cher";
  return <section className="v2-demo v2-wrap" id="demonstration" aria-labelledby="v2-demo-heading">
    <div className="v2-section-heading">
      <div>
        <span className="v2-section-kicker">EN SITUATION</span>
        <h2 id="v2-demo-heading">{story.title}, du panier à la liste.</h2>
      </div>
      <p>{story.fictional ? "Un exemple complet, avec des magasins et des prix fictifs." : `Un vrai panier, avec les prix relevés le ${demoDate(story.savedAt)}.`}</p>
    </div>

    <ol className="v2-demo-steps">
      <li className="v2-demo-step">
        <span className="v2-demo-step-number">01</span>
        <h3>Je remplis mon panier</h3>
        <p>{plural(count, "article")}{story.advanced ? ", chacun avec sa quantité" : ""}.{" "}
          {story.firstGroup ? `Un groupe comme «\u00a0${story.firstGroup}\u00a0» compare chaque marque et chaque format.` : "Chaque article est comparé dans tous les magasins."}</p>
        <div className="v2-demo-visual" aria-hidden="true">
          <ul className="v2-demo-chips">{story.articles.slice(0, 10).map(article => <li key={article.key} data-group={article.group}>
            {article.name}{article.quantity && <small> · {article.quantity}</small>}</li>)}
            {count > 10 && <li data-more="true">+ {count - 10}</li>}</ul>
        </div>
      </li>
      <li className="v2-demo-step">
        <span className="v2-demo-step-number">02</span>
        <h3>Je compare les magasins</h3>
        <p>{best ? `Les paniers complets passent en premier : ${lead} revient à ${money(best.cents)}, chez ${best.retailer}${best.drive ? ", en drive" : ""}.`
          : "Aucun magasin n’a tout le panier : les plus complets passent en premier."}</p>
        <div className="v2-demo-visual" aria-hidden="true">
          <ul className="v2-demo-ranking">{shown.map((store, index) => <li key={store.key} data-best={index === 0 && store.complete}>
            <span className="v2-demo-ranking-name"><b>{store.retailer}</b><small>{store.place}</small></span>
            {store.complete ? <span className="v2-demo-bar"><i style={{ width: `${Math.round(100 * store.cents / widest)}%` }} /></span>
              : <span className="v2-demo-partial">{store.count}/{count} articles</span>}
            {store.complete && <strong>{money(store.cents)}</strong>}
          </li>)}</ul>
        </div>
      </li>
      <li className="v2-demo-step">
        <span className="v2-demo-step-number">03</span>
        <h3>Je répartis mes courses</h3>
        <p>Chaque article au meilleur prix : {money(split.cents)} entre {plural(split.stores.length, "magasin")}.
          {left && (left.gainCents > 0 ? ` ${left.retailer} ne ferait gagner que ${money(left.gainCents)} : je le laisse de côté.`
            : ` ${left.retailer} ne ferait rien gagner : je le laisse de côté.`)}</p>
        <div className="v2-demo-visual" aria-hidden="true">
          <ul className="v2-demo-split">{split.stores.slice(0, 4).map(store => <li key={store.key} data-off={store.key === left?.key}>
            <span className="v2-demo-ranking-name"><b>{store.retailer}</b><small>{plural(store.count, "article")}</small></span>
            {store.key === left?.key ? <span className="v2-demo-pill">Désactivé</span> : <strong>{money(store.cents)}</strong>}
          </li>)}</ul>
        </div>
      </li>
      <li className="v2-demo-step">
        <span className="v2-demo-step-number">04</span>
        <h3>Je pars avec ma liste</h3>
        <p>Une liste par magasin, à cocher en rayon. Dans un panier partagé, elle se coche en direct pour tout le foyer.</p>
        {story.list && <div className="v2-demo-visual" aria-hidden="true">
          <div className="v2-demo-list">
            <span className="v2-demo-ranking-name"><b>{story.list.retailer}</b><small>{story.list.place}</small></span>
            <ul>{story.list.lines.map((line, index) => <li key={line} data-checked={index === 0}><i />{line}</li>)}</ul>
            {story.list.more > 0 && <small>+ {story.list.more} autre{story.list.more > 1 ? "s articles" : " article"}</small>}
          </div>
        </div>}
      </li>
    </ol>

    <div className="v2-demo-result">
      <div className="v2-demo-result-copy">
        <span className="v2-section-kicker">À LA FIN</span>
        <h3>{saving > 0 ? `${money(final.cents)} au lieu de ${money(best!.cents)}.` : `${money(final.cents)} pour ${final.priced < count ? `${plural(final.priced, "article")} avec un prix` : "tout le panier"}.`}</h3>
        <p>{plural(final.priced, "article")} réparti{final.priced > 1 ? "s" : ""} entre {plural(final.stores.length, "magasin")}
          {saving > 0 ? ` : ${money(saving)} d’économie (${percent} %) par rapport au meilleur magasin pour tout le panier.` : "."}</p>
        <p className="v2-demo-result-lead">Dans le panier de démonstration, tout se règle :</p>
        <ul className="v2-demo-features">
          <li>Quantités</li><li>Prix à l’unité</li><li>Filtres par magasin, commune ou département</li><li>Magasins désactivés</li><li>Liste de courses</li>
        </ul>
        <Link className="v2-button v2-button-primary" to={DEMO_BASKET_PATH}>Ouvrir le panier de démonstration <ArrowRightIcon /></Link>
        <p className="v2-demo-result-note">Sans compte ni crédit : tout se calcule sur votre appareil.</p>
      </div>
      <div className="v2-demo-receipt" role="group" aria-label="Le panier de démonstration">
        <div className="v2-journey-top">
          <span className="v2-journey-label">PANIER DE DÉMONSTRATION</span>
          <span className="v2-journey-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <div className="v2-demo-receipt-title">{story.title}</div>
        <ul className="v2-demo-receipt-stores">{final.stores.slice(0, 5).map(store => <li key={store.key}>
          <span className="v2-demo-ranking-name"><b>{store.retailer}</b><small>{store.place} · {plural(store.count, "article")}</small></span>
          <strong>{money(store.cents)}</strong>
        </li>)}</ul>
        <div className="v2-demo-receipt-total"><span>Total réparti</span><strong>{money(final.cents)}</strong></div>
        {saving > 0 && <p className="v2-demo-receipt-saving">− {money(saving)} par rapport à {best!.retailer}{best!.drive ? " en drive" : ""}</p>}
        <div className="v2-journey-footer">
          <span className="v2-journey-avatar"><CartIcon /></span>
          <span>{plural(count, "article")} · {plural(final.stores.length, "magasin")} · {prices}</span>
        </div>
      </div>
    </div>
  </section>;
}
