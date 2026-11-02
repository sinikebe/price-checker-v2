import { useState } from "react";

/** Administrator card: the browser extension, ready to load in a Chromium-based browser. */
export default function V2ExtensionDownload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function download() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const [{ extensionBundle }, { makeZip }] = await Promise.all([import("./v2-extension-files"), import("./v2-zip")]);
      const encoder = new TextEncoder();
      const zip = makeZip(extensionBundle(window.location.origin).map(file => ({ name: file.name, data: encoder.encode(file.text) })));
      const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url; link.download = "price-checker-extension.zip";
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError("L’archive n’a pas pu être préparée.");
    } finally { setBusy(false); }
  }

  return <section className="v2-settings-card v2-extension-download" aria-labelledby="v2-extension-heading">
    <h2 id="v2-extension-heading">Extension de navigateur (prototype)</h2>
    <p>Certaines enseignes bloquent les lectures automatiques depuis un serveur. L’extension lit un prix sur le site de l’enseigne, dans votre navigateur, avec votre session et votre magasin choisi, puis le propose à cette instance. Carrefour pour l’instant. Réservé aux administrateurs.</p>
    <ol className="v2-extension-steps">
      <li>Téléchargez l’archive et décompressez-la.</li>
      <li>Dans Chrome, Edge ou Brave : <code>chrome://extensions</code>, mode développeur, puis « Charger l’extension non empaquetée » sur le dossier décompressé.</li>
      <li>Choisissez votre drive sur carrefour.fr dans ce navigateur, une fois. C’est tout : sur la page du panier, « Récupérer les prix » lit aussi, tout seul, les prix Carrefour qui manquent, puis rafraîchit la comparaison.</li>
    </ol>
    <div className="v2-settings-actions">
      <button type="button" className="v2-button v2-button-primary" disabled={busy} onClick={() => { void download(); }}>
        {busy ? "Préparation…" : "Télécharger l’extension"}</button>
    </div>
    {error && <p className="v2-schedule-error" role="alert">{error}</p>}
  </section>;
}
