import V2IntegerSettingCard from "./V2IntegerSettingCard";
import { requestJson } from "./v2-http";

type ReferenceSettings = { unused_days: number; revision: number; count: number; min: number; max: number };

function request(method: "GET" | "PUT", body?: object): Promise<ReferenceSettings> {
  return requestJson<ReferenceSettings>("/api/v2/product-references/settings", { method, body, cache: "no-store", fallback: "Le réglage n’a pas pu être chargé." });
}

const load = () => request("GET");
const save = (value: number, revision: number) => request("PUT", { unused_days: value, expected_revision: revision });
const read = (settings: ReferenceSettings) => settings.unused_days;
const note = (settings: ReferenceSettings) => <>
  Entre {settings.min} et {settings.max} ; 0 pour les garder toujours. {settings.count} fiche{settings.count > 1 ? "s" : ""} de ce type actuellement.
  Ouvrir sa page, la comparer dans un panier ou l’ajouter compte comme une utilisation. Le nettoyage passe chaque heure.
</>;

/** Administrator setting: how long an unused product known only by its barcode is kept. */
export default function V2ReferenceSettings() {
  return <V2IntegerSettingCard name="reference-settings" title="Produits connus par leur seul code-barres"
    intro="Quand quelqu’un utilise un produit d’Open Food Facts absent du catalogue, une fiche ne contenant que son code-barres est créée pour y rattacher prix et paniers ; son nom et ses informations sont lus chez Open Food Facts par le navigateur. Une telle fiche sans rien de notre côté (ni prix, ni proposition, ni panier partagé, ni recette, ni signalement) est supprimée après le délai ci-dessous sans utilisation."
    label="Supprimer après (jours sans utilisation)" read={read} load={load} save={save} note={note} />;
}
