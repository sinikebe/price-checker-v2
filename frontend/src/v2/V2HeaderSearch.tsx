import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CloseIcon, SearchIcon } from "./V2SiteIcons";
import { SEARCH_MAX_LENGTH, searchPath, searchTermFromLocation } from "./v2-site-nav";
import "./v2-site-nav.css";

/** Search field of the header: runs the catalogue search. On narrow screens it opens from an icon. */
export default function V2HeaderSearch() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const shown = searchTermFromLocation(pathname, search);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);

  function close() { setOpen(false); toggle.current?.focus(); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = searchPath(String(new FormData(event.currentTarget).get("q") ?? ""));
    if (!target) return;
    setOpen(false);
    navigate(target);
  }
  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape" && open) { event.preventDefault(); close(); }
  }

  return <>
    <button ref={toggle} type="button" className="v2-search-toggle" aria-label="Rechercher" aria-expanded={open}
      onClick={() => setOpen(true)}><SearchIcon /></button>
    <form role="search" className={open ? "v2-site-search is-open" : "v2-site-search"} onSubmit={submit} onKeyDown={onKeyDown}>
      <label className="v2-site-sr-only" htmlFor="v2-site-search-field">Rechercher un produit, une marque ou un code-barres</label>
      <SearchIcon />
      <input key={shown} ref={field} id="v2-site-search-field" name="q" type="search" defaultValue={shown}
        placeholder="Rechercher un produit" maxLength={SEARCH_MAX_LENGTH} enterKeyHint="search" autoComplete="off" />
      <button type="button" className="v2-search-close" aria-label="Fermer la recherche" onClick={close}><CloseIcon /></button>
    </form>
  </>;
}
