import { useEffect } from "react";
import { Link } from "react-router-dom";
import "./v2-legal.css";

type LegalKind = "mentions" | "confidentialite" | "conditions";
const contact = "contact.pricechecker@proton.me";

function Contact() {
  return <a href={`mailto:${contact}`}>{contact}</a>;
}

function LegalContent({ kind }: { kind: LegalKind }) {
  if (kind === "mentions") return <>
    <section>
      <h2>Édition</h2>
      <p>Price Checker est édité à titre non professionnel par une personne physique établie en France, sous le pseudonyme « sini ». Les éléments d’identification personnelle de l’éditeur ont été communiqués à l’hébergeur. Ce pseudonyme ne désigne pas une société.</p>
      <p>Pour contacter l’éditeur, signaler un contenu ou exercer un droit relatif à vos données : <Contact />.</p>
    </section>
    <section>
      <h2>Hébergement</h2>
      <p>Hébergeur de l’application prévu pour la mise en production : Amazon Web Services EMEA SARL, 38 Avenue John F. Kennedy, L-1855 Luxembourg, téléphone +352 2789 0057. La région prévue pour le serveur est Europe (Stockholm), Suède.</p>
      <p>Le stockage de la base PostgreSQL de production est prévu chez <a href="https://supabase.com/" target="_blank" rel="noreferrer">Supabase</a>. La région exacte du projet Supabase doit encore être confirmée avant l’ouverture de la production.</p>
      <p>L’installation de développement privée est distincte de la future production. Les prestataires qui traitent des données sont décrits dans la <Link to="/v2/confidentialite">notice de confidentialité</Link>.</p>
    </section>
    <section>
      <h2>Contenus et contact</h2>
      <p>Les produits, prix et recettes proposés par les utilisateurs sont examinés avant publication. Les prix sont indicatifs et datés : vérifiez-les auprès du vendeur. Certaines fiches consultent <a href="https://world.openfoodfacts.org/" target="_blank" rel="noreferrer">Open Food Facts</a> ; les fiches sources sont identifiées lorsque leurs données sont utilisées.</p>
      <p>Un contenu peut être signalé depuis sa fiche lorsqu’un bouton de signalement est disponible, ou par e-mail à <Contact />.</p>
    </section>
  </>;

  if (kind === "confidentialite") return <>
    <section>
      <h2>Responsable et contact</h2>
      <p>Le responsable du traitement est l’éditeur de Price Checker, personne physique non professionnelle établie en France et utilisant publiquement le pseudonyme « sini ». Contact pour toute question ou demande concernant les données : <Contact />.</p>
    </section>
    <section>
      <h2>Données, usages et fondements</h2>
      <ul>
        <li><strong>Compte et accès :</strong> pseudo de connexion, empreinte du mot de passe, rôle, date de création et sessions. Ils servent à fournir l’espace personnel demandé et à en sécuriser l’accès (exécution du service demandé et intérêt légitime de sécurité).</li>
        <li><strong>Contributions :</strong> brouillons, propositions, prix, recettes, signalements, dates et liens internes avec le compte. Ils servent à gérer le catalogue, relire les propositions et traiter les abus (fourniture du service et intérêt légitime à maintenir un catalogue fiable).</li>
        <li><strong>Sécurité :</strong> cookie de session, informations techniques indispensables et limites de tentatives de connexion (intérêt légitime à protéger le service et ses utilisateurs).</li>
        <li><strong>Messages :</strong> adresse d’expédition et contenu des messages envoyés au contact public, pour répondre aux demandes et signalements (obligations relatives aux droits des personnes ou intérêt légitime selon la demande).</li>
      </ul>
      <p>Un pseudo et un mot de passe sont nécessaires pour créer un compte ; contribuer est facultatif. Aucun e-mail n’est demandé à l’inscription. Évitez d’inscrire des noms, coordonnées ou informations sensibles dans les champs libres. Les contributions validées sont visibles de tous, sans affichage du pseudo de leur auteur.</p>
    </section>
    <section>
      <h2>Destinataires et services externes</h2>
      <p>L’éditeur et les administrateurs habilités accèdent aux données privées nécessaires au fonctionnement et à la modération. Les contenus publiés sont accessibles à tous et peuvent être copiés ou mis en cache par des tiers.</p>
      <p>L’application de production est prévue sur AWS en Suède, avec une base PostgreSQL fournie par Supabase ; la région de ce projet Supabase reste à confirmer. Les messages adressés au contact sont traités par Proton Mail. Certaines images et fiches Open Food Facts peuvent être demandées directement par votre navigateur à Open Food Facts ; ce service reçoit alors les informations techniques liées à cette requête, notamment votre adresse IP. L’ouverture d’un lien externe vous conduit sur le site concerné.</p>
      <p>Supabase indique que les données principales du projet sont stockées dans sa région sélectionnée, mais que certains accès de support et traitements peuvent avoir lieu hors de cette région. Consultez ses <a href="https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq" target="_blank" rel="noreferrer">informations sur la résidence et les transferts</a>. La localisation exacte des copies techniques et les autres accès des prestataires dépendent de la configuration de l’instance et de leurs services. Pour demander des précisions sur une instance donnée, contactez-nous.</p>
    </section>
    <section>
      <h2>Durées de conservation</h2>
      <ul>
        <li>Le compte est conservé tant qu’il existe, jusqu’à sa suppression demandée. Il n’est pas automatiquement supprimé pour inactivité.</li>
        <li>Une session dure au maximum sept jours ; les données utilisées pour limiter les tentatives de connexion expirent plus vite.</li>
        <li>Les brouillons et propositions clos ainsi que les signalements traités sont supprimés six mois après leur décision. Un dossier encore ouvert reste conservé jusqu’à sa clôture, la suppression du compte ou une intervention.</li>
        <li>Les produits, prix et recettes publiés ne sont pas automatiquement supprimés au bout de six mois. Ils peuvent être corrigés ou retirés après signalement.</li>
        <li>Les messages reçus sont gardés le temps de traiter la demande, puis le temps nécessaire pour justifier la réponse ou respecter une obligation applicable.</li>
      </ul>
      <p>Les copies techniques éventuellement créées peuvent encore contenir temporairement des données supprimées du service actif ; leur effacement n’est pas instantané. Les copies déjà téléchargées par des tiers ne sont pas sous notre contrôle.</p>
    </section>
    <section>
      <h2>Votre appareil</h2>
      <p>Le cookie de session sert à maintenir la connexion. Le panier, le thème, certains brouillons et des données utiles au mode hors ligne sont stockés sur votre appareil. Ils peuvent subsister jusqu’à leur suppression dans l’application ou dans les réglages du navigateur. Le scanner n’utilise la caméra qu’après votre autorisation ; le décodage du code-barres se fait sur l’appareil.</p>
      <p>L’application V2 décrite ici n’emploie pas de traceur publicitaire ou de mesure d’audience. Si cela change, cette notice sera modifiée et les choix requis seront proposés.</p>
    </section>
    <section>
      <h2>Vos droits</h2>
      <p>Vous pouvez demander l’accès, la rectification, l’effacement ou la limitation de vos données, et vous opposer à certains traitements. La portabilité s’applique dans les cas prévus par la loi. Depuis <Link to="/v2/parametres">Paramètres → Mes données</Link>, un utilisateur connecté peut exporter ses données et, sauf compte administrateur initial, supprimer son compte.</p>
      <p>La suppression retire les données privées liées au compte et détache l’auteur des contenus déjà publiés ; ces contenus demeurent visibles. Elle ne supprime pas les exports déjà téléchargés, les données conservées sur d’autres appareils ni immédiatement toutes les copies techniques. Pour toute demande complémentaire : <Contact />. Vous pouvez aussi saisir la <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noreferrer">CNIL</a>.</p>
    </section>
  </>;

  return <>
    <section>
      <h2>Le service</h2>
      <p>Price Checker permet de consulter des produits, prix et recettes, de préparer un panier local et de proposer des contenus avec un compte. Le service est gratuit à ce stade. Les prix, compositions et autres informations sont indicatifs : vérifiez ce qui compte pour vous auprès du vendeur ou sur le produit avant achat ou utilisation.</p>
    </section>
    <section>
      <h2>Compte et contributions</h2>
      <p>Un compte utilise un pseudo et un mot de passe. Ne choisissez pas un pseudo contenant des données personnelles que vous ne voulez pas communiquer à la modération. Ne soumettez que des informations que vous êtes autorisé à partager, sans données personnelles d’autrui, contenu illicite ni contenu trompeur.</p>
      <p>Une création ou modification destinée au catalogue reste privée jusqu’à validation par l’administrateur. Une proposition peut être refusée ; un contenu déjà publié peut être corrigé ou retiré après signalement. La version déjà approuvée d’un contenu reste visible pendant l’examen d’une modification. Pour contester une décision ou signaler un contenu, écrivez à <Contact />.</p>
    </section>
    <section>
      <h2>Utilisation des contributions</h2>
      <p>Vous conservez vos droits sur vos textes et autres contributions. En proposant un contenu à publier, vous autorisez l’éditeur, à titre non exclusif et gratuit, à le reproduire, afficher, mettre en forme et corriger dans la mesure nécessaire au catalogue et à sa modération. Pour un contenu publié, cette autorisation continue après la suppression du compte tant que le contenu reste dans le catalogue ; vous pouvez demander un retrait motivé à <Contact />.</p>
      <p>Les éléments provenant d’Open Food Facts restent soumis aux conditions de cette source ; ils ne sont pas traités comme des contributions libres de droit à Price Checker.</p>
    </section>
    <section>
      <h2>Compte et données</h2>
      <p>Un utilisateur connecté peut exporter ses données et supprimer son compte dans <Link to="/v2/parametres">Paramètres → Mes données</Link>. Les produits, prix et recettes déjà publiés restent consultables sans lien affiché avec son compte. La <Link to="/v2/confidentialite">notice de confidentialité</Link> détaille les traitements et les limites de l’effacement.</p>
    </section>
    <section>
      <h2>Contact et évolution</h2>
      <p>Questions, signalements et demandes de retrait : <Contact />. Ces conditions peuvent évoluer avec le service ; leur version en vigueur est accessible depuis l’application.</p>
    </section>
  </>;
}

const titles: Record<LegalKind, string> = {
  mentions: "Mentions légales",
  confidentialite: "Confidentialité",
  conditions: "Conditions d’utilisation",
};

export default function V2LegalPage({ kind }: { kind: LegalKind }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${titles[kind]} | Price Checker`;
    return () => { document.title = previous; };
  }, [kind]);

  return <div className="v2-home v2-legal">
    <a className="v2-skip" href="#v2-legal-main">Aller au contenu</a>
    <header className="v2-header">
      <div className="v2-wrap v2-header-inner">
        <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
          <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
        </Link>
        <Link className="v2-legal-back" to="/v2">← Retour à l’accueil</Link>
      </div>
    </header>
    <main id="v2-legal-main" className="v2-wrap v2-legal-main">
      <span className="v2-section-kicker">PRICE CHECKER · INFORMATIONS</span>
      <h1>{titles[kind]}<span>.</span></h1>
      <p className="v2-legal-date">Version du 27 octobre 2026</p>
      <nav className="v2-legal-nav" aria-label="Informations légales">
        <Link to="/v2/mentions-legales" aria-current={kind === "mentions" ? "page" : undefined}>Mentions légales</Link>
        <Link to="/v2/confidentialite" aria-current={kind === "confidentialite" ? "page" : undefined}>Confidentialité</Link>
        <Link to="/v2/conditions-utilisation" aria-current={kind === "conditions" ? "page" : undefined}>Conditions d’utilisation</Link>
      </nav>
      <div className="v2-legal-content"><LegalContent kind={kind} /></div>
    </main>
  </div>;
}
