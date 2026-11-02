import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { V2User } from "./v2-auth-api";
import type { BasketItem } from "./v2-basket-storage";
import type { SharedBasketControls } from "./useSharedBasket";
import { listSharedBaskets, previewInvite } from "./v2-shared-basket-api";
import { STORAGE_NOTICE, inviteUrl, keepPendingInvite, type InvitePreview, type SharedSummary } from "./v2-shared-basket";
import "./v2-share.css";
import "./v2-shared-basket.css";

const STATUS = { connecting: "Connexion…", live: "En direct", retrying: "Reconnexion…" } as const;
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? "s" : ""}`;


/** The line at the top of the basket while a shared basket is open: who is in, whether it is live, what just changed. */
export function SharedBanner({ shared, user, onInvite }: { shared: SharedBasketControls; user: V2User | null; onInvite: () => void }) {
  const basket = shared.basket;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = basket?.role === "owner";
  async function run(action: () => Promise<unknown>) { setBusy(true); try { await action(); } finally { setBusy(false); } }
  return <section className="v2-shared-banner" aria-label="Panier partagé">
    <div className="v2-shared-banner-head">
      <div>
        <span className="v2-section-kicker">PANIER PARTAGÉ</span>
        <h2>{basket?.name ?? "Chargement…"}</h2>
        <p><span className="v2-shared-status" data-status={shared.status}>{STATUS[shared.status]}</span>
          {basket && <> · {plural(basket.members.length, "membre")} · {owner ? "créé par vous" : `créé par ${basket.owner ?? "un compte supprimé"}`}</>}</p>
      </div>
      <div className="v2-shared-banner-actions">
        <button type="button" className="v2-button v2-button-secondary" onClick={onInvite} disabled={!basket}>Inviter et membres</button>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => shared.open(null)}>Revenir à mon panier</button>
      </div>
    </div>
    <p className="v2-shared-activity" role="status" aria-live="polite">{shared.activity}</p>
    {shared.error && <p role="alert" className="v2-recipes-error">{shared.error}</p>}
    {shared.unavailable.length > 0 && <div className="v2-shared-unavailable" role="status">
      <p>Retiré du catalogue depuis son ajout, donc sans prix :</p>
      <ul>{shared.unavailable.map(line => <li key={line.id}>{line.label}
        {line.product_id && <button type="button" className="v2-basket-remove" onClick={() => shared.dropUnavailable(line.product_id!)}>Retirer</button>}</li>)}</ul>
    </div>}
    {basket && <details className="v2-shared-manage">
      <summary>Gérer le panier partagé</summary>
      {owner ? <div className="v2-shared-manage-body">
        {renaming ? <form onSubmit={event => { event.preventDefault(); void run(async () => { if (await shared.rename(name)) setRenaming(false); }); }}>
          <label>Nom du panier partagé<input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label>
          <button type="submit" className="v2-button v2-button-secondary" disabled={busy || !name.trim()}>Enregistrer</button>
          <button type="button" className="v2-button v2-button-secondary" onClick={() => setRenaming(false)}>Annuler</button>
        </form> : <button type="button" className="v2-button v2-button-secondary" onClick={() => { setName(basket.name); setRenaming(true); }}>Renommer</button>}
        <p className="v2-shared-warning">Supprimer ce panier l’efface du serveur pour tous ses membres, avec ses articles. <strong>Cette suppression est définitive : elle ne peut pas être annulée.</strong></p>
        <button type="button" className="v2-button v2-shared-danger" disabled={busy} onClick={() => {
          if (window.confirm(`Supprimer « ${basket.name} » pour tous ses membres ?\n\nCette suppression est définitive : elle ne peut pas être annulée.`)) void run(() => shared.remove());
        }}>Supprimer le panier partagé</button>
      </div> : <div className="v2-shared-manage-body">
        <p>Quitter ce panier le retire de vos paniers partagés. Les articles que vous y avez ajoutés restent ; un lien d’invitation valable permet de revenir.</p>
        <button type="button" className="v2-button v2-button-secondary" disabled={busy || !user} onClick={() => {
          if (user && window.confirm(`Quitter « ${basket.name} » ?`)) void run(() => shared.leave(user.id));
        }}>Quitter le panier partagé</button>
      </div>}
    </details>}
  </section>;
}

function InviteLink({ url, name }: { url: string; name: string }) {
  const [message, setMessage] = useState("");
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage("Lien d’invitation copié"); } catch { setMessage("Copie impossible sur cet appareil"); }
  }
  async function share() {
    try { await navigator.share({ title: `Panier partagé « ${name} »`, text: "Rejoignez ce panier partagé sur Price Checker :", url }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setMessage("Partage indisponible sur cet appareil"); }
  }
  async function toggleQr() {
    if (qr?.url === url) { setQr(null); return; }
    try { const { default: QRCode } = await import("qrcode"); setQr({ url, image: await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 240 }) }); }
    catch { setMessage("QR code indisponible : copiez le lien."); }
  }
  return <div className="v2-shared-invite-link">
    <input readOnly value={url} aria-label="Lien d’invitation" onFocus={event => event.target.select()} />
    <div className="v2-basket-share-actions">
      {typeof navigator.share === "function" && <button type="button" className="v2-share-button" onClick={() => void share()}>Partager</button>}
      <button type="button" className="v2-share-button" onClick={() => void copy()}>Copier le lien</button>
      <button type="button" className="v2-share-button" aria-expanded={qr?.url === url} onClick={() => void toggleQr()}>{qr?.url === url ? "Masquer le QR code" : "QR code"}</button>
    </div>
    {qr?.url === url && <div className="v2-basket-share-qr"><img src={qr.image} width="240" height="240" alt="QR code du lien d’invitation" /><p>À scanner avec un autre appareil.</p></div>}
    <p className="v2-share-feedback" role="status">{message}</p>
  </div>;
}

/** Invitation and members, in the share panel of an open shared basket. */
export function SharedInvite({ shared, user }: { shared: SharedBasketControls; user: V2User | null }) {
  const basket = shared.basket;
  const [busy, setBusy] = useState(false);
  if (!basket) return <p>Chargement du panier partagé…</p>;
  const owner = basket.role === "owner";
  async function run(action: () => Promise<unknown>) { setBusy(true); try { await action(); } finally { setBusy(false); } }
  return <section className="v2-shared-invite" aria-label="Inviter dans le panier partagé">
    <h3>Inviter</h3>
    <p>Toute personne connectée qui ouvre ce lien peut rejoindre « {basket.name} », voir ses articles et les modifier. Envoyez-le seulement aux personnes concernées.</p>
    <InviteLink url={inviteUrl(window.location.origin, basket.invite)} name={basket.name} />
    {owner && <p><button type="button" className="v2-button v2-button-secondary" disabled={busy} onClick={() => {
      if (window.confirm("Créer un nouveau lien d’invitation ? L’ancien ne fonctionnera plus ; les membres actuels restent.")) void run(() => shared.renewInvite());
    }}>Nouveau lien (l’ancien ne fonctionnera plus)</button></p>}
    <h3>Membres ({basket.members.length}/{basket.limits.members})</h3>
    <ul className="v2-shared-members">{basket.members.map(member => <li key={member.id}>
      <span>{member.username}{member.owner ? " · créateur" : ""}{member.id === user?.id ? " · vous" : ""}</span>
      {owner && !member.owner && <button type="button" className="v2-basket-remove" disabled={busy} onClick={() => {
        if (window.confirm(`Retirer ${member.username} du panier partagé ? Les articles ajoutés restent.`)) void run(() => shared.removeMember(member.id));
      }}>Retirer</button>}
    </li>)}</ul>
  </section>;
}

/** In the share panel when no shared basket is open: share this basket live, or open one already shared. */
export function SharedStart({ shared, user, items }: { shared: SharedBasketControls; user: V2User | null; items: BasketItem[] }) {
  const [name, setName] = useState("Courses partagées");
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<SharedSummary[] | null>(null);
  const [listError, setListError] = useState("");
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let active = true;
    listSharedBaskets().then(value => { if (active) setList(value.baskets); })
      .catch(reason => { if (active) setListError(reason instanceof Error ? reason.message : "Liste indisponible."); });
    return () => { active = false; };
  }, [userId]);
  if (!user) return <section className="v2-shared-start" aria-label="Partager en direct">
    <h3>Partager en direct</h3>
    <p>Un panier partagé se modifie à plusieurs, en direct. <Link to="/v2/connexion?next=panier">Connectez-vous</Link> pour en créer un ou en rejoindre un.</p>
  </section>;
  const tooMany = items.length > 100;
  return <section className="v2-shared-start" aria-label="Partager en direct">
    <h3>Partager en direct</h3>
    <p>Créez un panier partagé à partir de ce panier : les personnes que vous invitez voient en direct ce qui y est ajouté, et peuvent ajouter, cocher ou retirer des articles.</p>
    <p className="v2-shared-warning">{STORAGE_NOTICE}</p>
    <form className="v2-shared-create" onSubmit={event => {
      event.preventDefault();
      if (busy || tooMany) return;
      setBusy(true);
      void shared.create(name.trim(), items).finally(() => setBusy(false));
    }}>
      <label>Nom du panier partagé<input value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></label>
      <button type="submit" className="v2-button v2-button-primary" disabled={busy || tooMany || !name.trim()}>{busy ? "Création…" : "Créer et enregistrer sur le serveur"}</button>
    </form>
    {tooMany && <p role="alert">Un panier partagé compte 100 articles au plus.</p>}
    {shared.error && <p role="alert" className="v2-recipes-error">{shared.error}</p>}
    <p className="v2-shared-hint">Votre panier personnel reste sur cet appareil : « Revenir à mon panier » le retrouve à tout moment.</p>
    {listError && <p role="alert">{listError}</p>}
    {list && list.length > 0 && <><h3>Vos paniers partagés</h3>
      <ul className="v2-shared-list">{list.map(item => <li key={item.id}><span><strong>{item.name}</strong> · {item.owner ? "créé par vous" : `de ${item.owner_name}`} · {plural(item.lines, "article")} · {plural(item.members, "membre")}</span>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => shared.open(item.id)}>Ouvrir</button></li>)}</ul></>}
  </section>;
}

/** Opened from an invitation link: who shares what, what joining stores, then join or ignore. */
export function SharedJoin({ invite, user, shared, onClose }: { invite: string; user: V2User | null; shared: SharedBasketControls; onClose: () => void }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let active = true;
    previewInvite(invite).then(value => { if (active) setPreview(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Lien d’invitation indisponible."); });
    return () => { active = false; };
  }, [invite, userId]);
  return <section className="v2-shared-basket v2-shared-join" aria-label="Rejoindre un panier partagé">
    <h2>Rejoindre un panier partagé</h2>
    {!user ? <>
      <p>Connectez-vous pour rejoindre ce panier partagé : l’invitation sera reprise après la connexion.</p>
      <div className="v2-shared-basket-actions"><Link className="v2-button v2-button-primary" to="/v2/connexion?next=panier" onClick={() => keepPendingInvite(invite)}>Se connecter</Link>
        <button type="button" className="v2-button v2-button-secondary" onClick={onClose}>Ignorer</button></div>
    </> : error ? <><p role="alert">{error}</p><button type="button" className="v2-button v2-button-secondary" onClick={onClose}>Fermer</button></>
      : !preview ? <p>Vérification de l’invitation…</p> : <>
        <p><strong>« {preview.name} »</strong>, partagé par {preview.owner} · {plural(preview.lines, "article")} · {plural(preview.members, "membre")}.</p>
        {preview.member ? <p>Vous faites déjà partie de ce panier partagé.</p> : <>
          <p>En le rejoignant, vous voyez et modifiez ses articles en direct, comme ses autres membres, qui voient votre nom d’utilisateur.</p>
          <p className="v2-shared-warning">Les articles que vous y ajoutez sont enregistrés sur le serveur avec ce panier, jusqu’à ce que son créateur le supprime ou supprime son compte. Votre panier personnel reste sur cet appareil.</p>
        </>}
        <div className="v2-shared-basket-actions">
          <button type="button" className="v2-button v2-button-primary" disabled={busy} onClick={() => {
            setBusy(true);
            void shared.join(invite).then(joined => { if (joined) onClose(); }).finally(() => setBusy(false));
          }}>{preview.member ? "Ouvrir le panier partagé" : busy ? "Connexion…" : "Rejoindre"}</button>
          <button type="button" className="v2-button v2-button-secondary" onClick={onClose}>Ignorer</button>
        </div>
        {shared.error && <p role="alert">{shared.error}</p>}
      </>}
  </section>;
}
