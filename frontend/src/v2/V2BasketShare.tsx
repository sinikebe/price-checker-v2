import { useState } from "react";
import type { BasketItem } from "./v2-basket-storage";
import { basketShareList } from "./v2-basket-share-labels";
import "./v2-share.css";
import "./v2-basket-share.css";

export default function V2BasketShare({ items, url }: { items: BasketItem[]; url: string | null }) {
  const [message, setMessage] = useState("");
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  const [qrPending, setQrPending] = useState(false);
  const list = basketShareList(items, url);
  const qrVisible = !!url && qr?.url === url;

  async function copy(value: string, success: string) {
    try { await navigator.clipboard.writeText(value); setMessage(success); }
    catch { setMessage("Copie impossible sur cet appareil"); }
  }
  async function nativeShare() {
    if (!url || !navigator.share) return;
    try { await navigator.share({ title: "Mon panier Price Checker", text: list, url }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setMessage("Partage indisponible sur cet appareil"); }
  }
  async function toggleQr() {
    if (!url || qrPending) return;
    if (qrVisible) { setQr(null); return; }
    setMessage(""); setQrPending(true);
    try {
      const { default: QRCode } = await import("qrcode");
      setQr({ url, image: await QRCode.toDataURL(url, { errorCorrectionLevel: "L", margin: 2, width: 280 }) });
    } catch { setMessage("Lien trop long pour un QR code. Copiez le lien ou la liste."); }
    finally { setQrPending(false); }
  }
  return <section className="v2-basket-share" aria-label="Partager mon panier">
    <div className="v2-basket-share-actions">
      {typeof navigator.share === "function" && <button type="button" className="v2-share-button" disabled={!url} onClick={() => void nativeShare()}>Partager</button>}
      <button type="button" className="v2-share-button" disabled={!url} onClick={() => { if (url) void copy(url, "Lien copié avec les quantités"); }}>Copier le lien</button>
      <button type="button" className="v2-share-button" disabled={!items.length} onClick={() => void copy(list, url ? "Liste et lien copiés" : "Liste copiée")}>Copier la liste</button>
      <button type="button" className="v2-share-button" disabled={!url || qrPending} aria-expanded={qrVisible} onClick={() => void toggleQr()}>{qrPending ? "Création…" : qrVisible ? "Masquer le QR code" : "QR code"}</button>
    </div>
    {items.length > 0 && !url && <p className="v2-basket-share-hint">Panier trop volumineux pour un lien ; la liste reste copiable.</p>}
    {qrVisible && qr && <div className="v2-basket-share-qr"><img src={qr.image} width="280" height="280" alt="QR code du lien vers le panier partagé" /><p>À scanner avec un autre appareil.</p></div>}
    <p className="v2-share-feedback" role="status">{message}</p>
  </section>;
}
