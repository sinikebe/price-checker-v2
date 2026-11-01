import { useLocation, useNavigate } from "react-router-dom";
import { ChevronLeftIcon } from "./V2SiteIcons";
import { backTarget } from "./v2-site-nav";
import "./v2-site-nav.css";

/** Goes back in the app's own history, or to the parent page when there is none. Hidden on the home page. */
export default function V2BackButton() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const target = backTarget(pathname);
  if (!target) return null;
  function back() {
    // React Router numbers the entries of its own history: above 0, there is a previous page of the app.
    const index = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof index === "number" && index > 0) navigate(-1);
    else navigate(target as string);
  }
  return <button type="button" className="v2-back-button" onClick={back}
    aria-label="Page précédente" title="Page précédente"><ChevronLeftIcon /></button>;
}
