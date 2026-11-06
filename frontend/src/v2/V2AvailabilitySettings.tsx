import V2IntegerSettingCard from "./V2IntegerSettingCard";
import { loadRecheckSettings, recheckSummary, saveRecheckSettings, type RecheckSettings } from "./v2-availability";

const read = (settings: RecheckSettings) => settings.recheck_days;
const note = (settings: RecheckSettings) => <>
  Entre {settings.min} et {settings.max} ; 0 pour ne jamais revérifier seul. {recheckSummary(settings.recheck_days)} Sur la page d’un produit, un administrateur peut aussi demander une nouvelle vérification d’un magasin.
</>;

/** Administrator setting: how long a product withdrawn from a store's range is left alone. */
export default function V2AvailabilitySettings() {
  return <V2IntegerSettingCard name="availability-settings" className="v2-availability-settings" title="Produits retirés de la gamme"
    intro="Quand un magasin ne vend plus un produit, seul ce magasin est concerné : le produit et ses autres prix restent en place. Le connecteur ne relit plus cette page à chaque cycle de fraîcheur ; il y revient après le délai ci-dessous, ou dès qu’un prix plus récent y est relevé."
    label="Délai avant de revérifier (jours)" read={read} load={loadRecheckSettings} save={saveRecheckSettings} note={note} />;
}
