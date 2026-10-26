import { Link } from "react-router-dom";
import { useV2Basket } from "./V2BasketContext";
import type { V2User } from "./v2-auth-api";
import "./v2-recipes.css";

export default function V2BasketPage({ user, onLogout }: { user: V2User | null; onLogout: () => Promise<void> }) {
  const { products, remove, clear } = useV2Basket();
  return <div className="v2-home v2-recipes">
    <a className="v2-skip" href="#v2-basket-main">Aller au contenu</a>
    <header className="v2-header"><div className="v2-wrap v2-header-inner">
      <Link className="v2-brand" to="/v2">price<span className="v2-brand-accent">checker</span>.</Link>
      <nav className="v2-nav" aria-label="Navigation principale"><Link to="/v2">Accueil</Link><Link to="/v2/produits">Produits</Link><Link to="/v2/recettes">Recettes</Link><Link className="v2-nav-current" to="/v2/panier" aria-current="page">Panier</Link><Link to="/v2/parametres">Paramètres</Link>{user ? <button type="button" onClick={() => void onLogout()}>Déconnexion</button> : <Link to="/v2/connexion">Connexion</Link>}</nav>
    </div></header>
    <main id="v2-basket-main" className="v2-wrap v2-recipes-main">
      <div className="v2-recipes-heading"><div><span className="v2-section-kicker">VOS COURSES</span><h1>Mon panier<span>.</span></h1><p>Enregistré sur cet appareil et disponible hors ligne. Les prix apparaîtront lorsqu’ils seront disponibles.</p></div><Link className="v2-button v2-button-secondary" to="/v2/produits">Choisir des produits →</Link></div>
      {products.length ? <><ul className="v2-recipes-list">{products.map(product => <li className="v2-recipes-tile" key={product.id}><Link to={`/v2/produits/${product.id}`}><strong>{product.data.brand} {product.data.name}</strong></Link><span>{product.data.quantity || "Quantité non précisée"} · {product.data.group || "Sans groupe"}</span><button type="button" className="v2-button v2-button-secondary" onClick={() => remove(product.id)}>Retirer</button></li>)}</ul><button type="button" className="v2-button v2-button-secondary" onClick={() => { if (window.confirm("Vider le panier ?")) clear(); }}>Vider le panier</button></> : <div className="v2-recipes-card"><p>Votre panier est vide pour le moment.</p></div>}
    </main>
  </div>;
}
