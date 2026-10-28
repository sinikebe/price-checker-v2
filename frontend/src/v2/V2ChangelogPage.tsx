import { Link, Navigate } from "react-router-dom";
import versions from "./component-versions.json";
import changelog from "./component-changelog.json";
import "./v2-home.css";
import "./v2-versions.css";
import "./v2-changelog.css";

type ComponentId = keyof typeof versions;

type ReleaseEntry = { version: string; notes: string[] };
type Release = {
  application_version: string;
  components: Partial<Record<ComponentId, ReleaseEntry>>;
};

const releases = (changelog.releases as Release[]).slice().reverse();
const baseline = changelog.baseline as Record<ComponentId, string[]>;

function NoteList({ items }: { items: string[] }) {
  return <ul className="v2-changelog-notes">{items.map(note => <li key={note}>{note}</li>)}</ul>;
}

export default function V2ChangelogPage({ componentId }: { componentId?: string }) {
  if (componentId && !(componentId in versions)) return <Navigate to="/v2/changelog" replace />;
  const selected = componentId as ComponentId | undefined;
  const relevant = selected ? releases.filter(release => release.components[selected]) : releases;

  return <div className="v2-home v2-versions v2-changelog">
    <main className="v2-wrap">
      <Link className="v2-versions-back" to={selected ? "/v2/changelog" : "/v2/versions"}>← {selected ? "Tous les composants" : "Versions des composants"}</Link>
      <span className="v2-section-kicker">NOUVEAUTÉS</span>
      <h1>{selected ? versions[selected].label : "Journal des nouveautés"}</h1>
      <p>{selected
        ? `Version actuelle : v${versions[selected].version}. Les changements de ce composant, mise à jour après mise à jour.`
        : "Les changements qui comptent, composant par composant. Le détail utile, sans le mode d’emploi."}</p>
      {relevant.length ? relevant.map(release => <section className="v2-changelog-release" key={release.application_version}>
        <h2>Mise à jour v{release.application_version}</h2>
        <div className="v2-changelog-cards">
          {(Object.entries(release.components) as [ComponentId, ReleaseEntry][])
            .filter(([id]) => !selected || id === selected)
            .map(([id, entry]) => <article className="v2-changelog-card" key={id}>
              <h3>{selected ? versions[id].label : <Link to={`/v2/changelog/${id}`}>{versions[id].label}</Link>} <span>v{entry.version}</span></h3>
              <NoteList items={entry.notes} />
            </article>)}
        </div>
      </section>) : <p className="v2-changelog-empty">Pas encore de note de mise à jour pour ce composant.</p>}
      <section className="v2-changelog-baseline">
        <h2>Déjà en place</h2>
        <p>Quelques ajouts marquants datant d’avant la mise en place du journal.</p>
        <div className="v2-changelog-cards">
          {(Object.entries(baseline) as [ComponentId, string[]][])
            .filter(([id]) => !selected || id === selected)
            .map(([id, summary]) => <article className="v2-changelog-card" key={id}>
              <h3>{selected ? versions[id].label : <Link to={`/v2/changelog/${id}`}>{versions[id].label}</Link>}</h3>
              <NoteList items={summary} />
            </article>)}
        </div>
      </section>
    </main>
  </div>;
}
