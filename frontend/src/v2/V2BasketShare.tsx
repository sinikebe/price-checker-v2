import { useRef, useState } from "react";
import type { BasketItem } from "./v2-basket-storage";
import { basketQuantityLabel, basketShareList } from "./v2-basket-share-labels";
import "./v2-share.css";
import "./v2-basket-share.css";

export default function V2BasketShare({ items, url }: { items: BasketItem[]; url: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState("");
  const [qr, setQr] = useState("");
  const [qrPending, setQrPending] = useState(false);
  const list = basketShareList(items, url);

  async function copy(value: string, success: string) {
    try { await navigator.clipboard.writeText(value); setMessage(success); }
    catch { setMessage("Copie impossible sur cet appareil"); }
  }
  async function nativeShare() {
    if (!url || !navigator.share) return;
    try { await navigator.share({ title: "Mon panier Price Checker", text: list, url }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setMessage("Partage indisponible sur cet appareil"); }
  }
  async function showQr() {
    if (!url || qrPending) return;
    setMessage(""); setQr(""); setQrPending(true);
    try {
      const { default: QRCode } = await import("qrcode");
      setQr(await QRCode.toDataURL(url, { errorCorrectionLevel: "L", margin: 2, width: 280 }));
    } catch { setMessage("Lien trop long pour un QR code. Copiez le lien ou la liste."); }
    finally { setQrPending(false); }
  }
  return <span className="v2-share-control">
    <button type="button" className="v2-share-button" disabled={!items.length} title={!items.length ? "Rien à partager" : "Options de partage du panier"} onClick={() => { setMessage(""); setQr(""); dialog.current?.showModal(); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>
      Partager
    </button>
    <dialog ref={dialog} className="v2-basket-share-dialog" aria-labelledby="v2-basket-share-title">
      <div className="v2-basket-share-top"><h2 id="v2-basket-share-title">Partager mon panier</h2><button type="button" className="v2-basket-share-close" aria-label="Fermer" onClick={() => dialog.current?.close()}>×</button></div>
      <p>{url ? "Le lien et le QR code contiennent les articles, leurs quantités et les exclusions. Pas de prix ni de magasins." : "Ce panier est trop volumineux pour un lien. Vous pouvez copier sa liste."}</p>
      <ul className="v2-basket-share-list">{items.map((item, index) => <li key={index}>{"kind" in item ? item.name : [item.data.brand, item.data.name].filter(Boolean).join(" ")} <span>· {basketQuantityLabel(item.quantity)}{item.disabled ? " · exclu" : ""}</span></li>)}</ul>
      <div className="v2-basket-share-actions">
        {typeof navigator.share === "function" && <button type="button" className="v2-button v2-button-primary" onClick={() => void nativeShare()}>Partager via une application</button>}
        <button type="button" className="v2-button v2-button-secondary" disabled={!url} onClick={() => { if (url) void copy(url, "Lien copié avec les quantités"); }}>Copier le lien</button>
        <button type="button" className="v2-button v2-button-secondary" onClick={() => void copy(list, url ? "Liste et lien copiés" : "Liste copiée")}>Copier la liste</button>
        <button type="button" className="v2-button v2-button-secondary" disabled={!url || qrPending} onClick={() => void showQr()}>{qrPending ? "Création…" : "Afficher le QR code"}</button>
      </div>
      {qr && <div className="v2-basket-share-qr"><img src={qr} width="280" height="280" alt="QR code du lien vers le panier partagé" /><p>À scanner avec un autre appareil.</p></div>}
      <p className="v2-share-feedback" role="status">{message}</p>
    </dialog>
  </span>;
}
