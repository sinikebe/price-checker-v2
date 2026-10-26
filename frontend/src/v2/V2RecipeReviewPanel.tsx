import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { recipeRequest, type RecipeReview } from "./v2-recipes-api";

const PAGE_SIZE = 30;

export default function V2RecipeReviewPanel() {
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<RecipeReview[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    recipeRequest<RecipeReview[]>(`/submissions/review?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then(value => { if (active) { setItems(value); setError(""); } })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [page, reload]);
  async function decide(item: RecipeReview, action: "approve" | "reject") {
    if (action === "approve" && !window.confirm(`Publier la proposition « ${item.payload.title} » ?`)) return;
    setBusy(item.id); setError("");
    try {
      await recipeRequest(`/submissions/${item.id}/${action}`, "POST");
      setReload(value => value + 1);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  }
  return <section className="v2-settings-card" aria-labelledby="v2-recipe-review-heading">
    <h2 id="v2-recipe-review-heading">Recettes à valider</h2>
    {error && <p role="alert">{error}</p>}
    {!items && !error && <p>Chargement…</p>}
    {items?.length === 0 && <p>Aucune proposition en attente.</p>}
    {items?.map(item => <article key={item.id}>
      <h3>{item.payload.title}</h3>
      <p>{item.recipe_id ? <>Modification de la <Link to={`/v2/recettes/${item.recipe_id}`}>recette #{item.recipe_id}</Link></> : "Nouvelle recette"} · Proposition de {item.author}</p>
      <details><summary>Examiner le texte et les ingrédients</summary>
        {item.payload.description && <p>{item.payload.description}</p>}
        <p>{item.payload.base_servings} portions · préparation {item.payload.prep_minutes ?? "—"} min · cuisson {item.payload.cook_minutes ?? "—"} min</p>
        <h4>Ingrédients</h4><ul>{item.payload.ingredients.map((ingredient, index) => <li key={index}>
          {ingredient.label} · {ingredient.amount ?? "—"} {ingredient.unit ?? ""} · {ingredient.product_id ? `Produit #${ingredient.product_id}` : `Groupe ${ingredient.group_name}`}
          {ingredient.note && <> · {ingredient.note}</>}
        </li>)}</ul>
        <h4>Étapes</h4><ol>{item.payload.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      </details>
      <div className="v2-settings-actions">
        <button type="button" className="v2-button v2-button-primary" disabled={busy !== null} onClick={() => { void decide(item, "approve"); }}>Valider et publier</button>
        <button type="button" className="v2-button v2-button-secondary" disabled={busy !== null} onClick={() => { void decide(item, "reject"); }}>Refuser</button>
      </div>
    </article>)}
    {items && (page > 0 || items.length === PAGE_SIZE) && <div className="v2-settings-actions">
      <button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Précédent</button>
      <span>Page {page + 1}</span>
      <button type="button" disabled={items.length < PAGE_SIZE} onClick={() => setPage(value => value + 1)}>Suivant</button>
    </div>}
  </section>;
}
