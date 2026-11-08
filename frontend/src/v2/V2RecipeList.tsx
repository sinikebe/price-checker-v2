import { useEffect, useState } from "react";
import V2Info from "./V2Info";
import { Link, useLocation } from "react-router-dom";
import { V2PageFrame } from "./V2SiteHeader";
import { decimalText } from "../recipes/quantity";
import { recipeRequest, type PrivateRecipePage, type RecipePage, type RecipeSubmission } from "./v2-recipes-api";
import { message, privatePath, type Props } from "./v2-recipes-format";
import { offlineRecipesReady } from "./v2-recipes-local";
import { offlineRecipeSummaries, SYNC_EVENT } from "../pwa/data-sync";
import { useAppMode } from "./useAppMode";
import { useDebouncedValue } from "./useDebouncedValue";
import { SEARCH_DEBOUNCE_MS } from "./v2-catalogue-search";
import "./v2-recipes.css";

export default function V2RecipeList({ user, onLogout }: Props) {
  // Writing recipes is contributing: the contribution mode's job. Shopping reads them and fills the basket.
  const contributing = useAppMode().mode === "contribute";
  const [q, setQ] = useState("");
  // The list follows the text once the typing pauses: one request per search, not per key.
  const searched = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  // A new search starts on its first page. The page goes back to 1 with the searched text, not on
  // each key: from page 2, a key press would otherwise ask at once for page 1 of the old search.
  const [pagedSearch, setPagedSearch] = useState(searched);
  if (pagedSearch !== searched) { setPagedSearch(searched); setPage(1); }
  const [result, setResult] = useState<RecipePage | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [submissions, setSubmissions] = useState<RecipeSubmission[]>([]);
  const [submissionError, setSubmissionError] = useState("");
  const [own, setOwn] = useState<PrivateRecipePage | null>(null);
  const [ownError, setOwnError] = useState("");
  const location = useLocation();
  const userId = user?.id;
  useEffect(() => {
    let active = true;
    if (!userId) return;
    recipeRequest<RecipeSubmission[]>("/submissions/mine").then(value => {
      if (active) { setSubmissions(value); setSubmissionError(""); }
    }).catch(reason => { if (active) setSubmissionError(message(reason)); });
    recipeRequest<PrivateRecipePage>("/private").then(value => {
      if (active) { setOwn(value); setOwnError(""); }
    }).catch(reason => { if (active) setOwnError(message(reason)); });
    return () => { active = false; };
  }, [userId, refresh]);
  useEffect(() => { const updated = () => setRefresh(value => value + 1); window.addEventListener(SYNC_EVENT, updated); return () => window.removeEventListener(SYNC_EVENT, updated); }, []);
  useEffect(() => {
    let active = true;
    recipeRequest<RecipePage>(`?q=${encodeURIComponent(searched)}&page=${page}`)
      .then(value => { if (active) { setResult(value); setError(""); } })
      .catch(reason => {
        if (!active) return;
        // Offline, the copy of the public recipes answers, unless it was never completed.
        const all = offlineRecipeSummaries().filter(item => item.title.toLocaleLowerCase().includes(searched.toLocaleLowerCase()));
        if (all.length || offlineRecipesReady()) setResult({ items: all.slice((page - 1) * 20, page * 20), total: all.length, page, page_size: 20 });
        else setError(message(reason));
      });
    return () => { active = false; };
  }, [searched, page, refresh]);
  return <V2PageFrame section="recipes" user={user} onLogout={onLogout}>
    <div className="v2-recipes-heading"><div><span className="v2-section-kicker">À CUISINER</span><h1>Recettes<span>.</span></h1><p>Des ingrédients précis quand vous le souhaitez, ou un groupe pour garder le choix.</p></div>
      {contributing && <Link className="v2-button v2-button-primary" to="/v2/recettes/nouvelle">Ajouter une recette →</Link>}</div>
    {location.search.includes("proposition=envoyee") && <p role="status" className="v2-recipes-card">Proposition envoyée. Elle sera visible publiquement après validation.</p>}
    {user && <section className="v2-recipes-card" aria-label="Mes recettes privées"><h2>Mes recettes privées <V2Info>Visibles par vous seul, sans validation et sans crédits.</V2Info></h2>
      {ownError && <p role="alert">{ownError}</p>}
      {own && !own.items.length && !ownError && <p>{contributing ? "Aucune recette privée. Choisissez « Privée » en ajoutant une recette." : "Aucune recette privée. Le mode contribution permet d’en écrire."}</p>}
      {own && own.items.length > 0 && <div className="v2-recipes-list">{own.items.map(recipe => <Link key={recipe.id} to={privatePath(recipe.id)} className="v2-recipes-tile"><strong>{recipe.title}</strong><span>{decimalText(recipe.base_servings)} portions · {recipe.ingredient_count} ingrédients</span>{recipe.publication && <span className="v2-recipes-private-badge">{recipe.publication === "pending" ? "Publication en attente" : "Publication refusée"}</span>}</Link>)}</div>}
    </section>}
    {contributing && user && <section className="v2-recipes-card" aria-label="Mes propositions de recettes"><h2>Mes propositions</h2>
      {submissionError && <p role="alert">{submissionError}</p>}
      {!submissions.length && !submissionError && <p>Aucune proposition récente.</p>}
      {submissions.map(item => <p key={item.id}><strong>{item.title}</strong> · {item.status === "pending" ? "En attente de validation" : item.status === "rejected" ? "Refusée" : "Validée"}
        {item.status === "approved" && item.result_recipe_id ? <> · <Link to={`/v2/recettes/${item.result_recipe_id}`}>Voir la recette</Link></> : item.status !== "approved" ? <> · <Link to={`/v2/recettes/nouvelle?reprendre=${item.id}`}>Modifier la proposition</Link></> : null}</p>)}
    </section>}
    <label className="v2-recipes-search">Rechercher une recette<input type="search" maxLength={100} value={q} onChange={event => setQ(event.target.value)} placeholder="Nom de la recette" /></label>
    {error && <p role="alert" className="v2-recipes-error">{error}</p>}
    {!result && !error && <p>Chargement…</p>}
    {result && <><div className="v2-recipes-list">{result.items.map(recipe => <Link key={recipe.id} to={`/v2/recettes/${recipe.id}`} className="v2-recipes-tile"><strong>{recipe.title}</strong><span>{decimalText(recipe.base_servings)} portions · {recipe.ingredient_count} ingrédients</span>{recipe.description && <p>{recipe.description}</p>}</Link>)}</div>
      {!result.items.length && <p className="v2-recipes-empty">Aucune recette pour le moment.</p>}
      {result.total > result.page_size && <div className="v2-recipes-pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button><span>Page {page} / {Math.ceil(result.total / result.page_size)}</span><button disabled={page * result.page_size >= result.total} onClick={() => setPage(page + 1)}>Suivant</button></div>}
    </>}
  </V2PageFrame>;
}
