import { Link } from "react-router-dom";

/** The site's mark and name, linking home. Only the site header names the word's class, for its narrow layout. */
export default function V2Brand({ wordClassName }: { wordClassName?: string }) {
  return <Link className="v2-brand" to="/v2" aria-label="Price Checker, accueil V2">
    <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
    <span className={wordClassName}>price<span className="v2-brand-accent">checker</span><span className="v2-brand-period">.</span></span>
  </Link>;
}
