import List from "./V2RecipeList";
import Detail from "./V2RecipeDetail";
import Editor from "./V2RecipeEditor";
import type { Props } from "./v2-recipes-format";

/** The recipe pages: the list, one recipe, and the editor that writes a new one or changes it. */
export default function V2RecipesPage(props: Props) {
  if (props.mode === "list") return <List key={props.user?.id ?? "anon"} {...props} />;
  // Keyed by account too: signing out drops a private recipe from the page at once.
  if (props.mode === "detail") return <Detail key={`${props.privateRecipe ? "private" : "public"}:${props.id}:${props.user?.id ?? "anon"}`} {...props} />;
  return <Editor key={`${props.mode}:${props.privateRecipe ? "private" : "public"}:${props.id}:${props.user?.id ?? "anon"}:${window.location.search}`} {...props} />;
}
