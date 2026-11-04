import "./v2-catalogue.css";

/** The levels of the catalogue tree, from the widest to a single product. */
export type Level = "department" | "family" | "scope" | "group" | "product";
const levelLabels: Record<Level, string> = {
  department: "Rayon", family: "Famille", scope: "Ensemble", group: "Groupe comparable", product: "Produit",
};
const levelPaths: Record<Level, string> = {
  department: "M3 21V5h18v16M7 5V3h10v2M7 9h2m6 0h2M7 13h2m6 0h2M10 21v-5h4v5",
  family: "M3 7h6l2 2h10v11H3zM3 7V5h6l2 2",
  scope: "M8 5a7 7 0 1 0 0 14m8-14a7 7 0 1 1 0 14M5 12h14",
  group: "M5 7h14M5 12h14M5 17h14M3 7h0m0 5h0m0 5h0",
  product: "M5 8 12 4l7 4v10l-7 4-7-4zM5 8l7 4 7-4m-7 4v10",
};
/** A level of the catalogue tree, with its icon and its name. */
export default function LevelBadge({ level }: { level: Level }) {
  return <span className={"v2-catalogue-level v2-catalogue-level-" + level}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={levelPaths[level]} />
    </svg><span>{levelLabels[level]}</span>
  </span>;
}
