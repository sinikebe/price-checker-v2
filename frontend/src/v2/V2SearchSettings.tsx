import V2IntegerSettingCard from "./V2IntegerSettingCard";
import { requestJson } from "./v2-http";

type Settings = { complete_list_max: number; revision: number; min: number; max: number; per_minute: number; per_hour: number };

function settingsRequest(method: "GET" | "PUT", body?: object): Promise<Settings> {
  return requestJson<Settings>("/api/v2/catalogue/search-settings", { method, body, cache: "no-store", fallback: "Le réglage n’a pas pu être enregistré." });
}

const load = () => settingsRequest("GET");
const save = (value: number, revision: number) => settingsRequest("PUT", { complete_list_max: value, expected_revision: revision });
const read = (settings: Settings) => settings.complete_list_max;
const note = (settings: Settings) => <>
  Entre {settings.min} et {settings.max}. Chaque visiteur peut lancer {settings.per_minute} recherches par minute et {settings.per_hour} par heure.
</>;

/** Administrator setting of the catalogue search: how many matches the server lists in full. */
export default function V2SearchSettings() {
  return <V2IntegerSettingCard name="search-settings" className="v2-search-settings" title="Recherche dans le catalogue"
    intro="La recherche s’affiche au fil de la saisie. Le serveur n’envoie la liste complète que lorsque peu de produits correspondent ; au-delà, il indique seulement leur nombre, puis le navigateur filtre la liste reçue sans nouvelle requête."
    label="Nombre maximal de produits listés" read={read} load={load} save={save} note={note} />;
}
