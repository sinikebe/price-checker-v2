import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import V2BarcodeScanner from "./V2BarcodeScanner";
import { resolveBarcodePath } from "./v2-barcode";
import { isBarcode } from "./v2-catalogue-search";

export default function V2BarcodeSearch({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const [barcode, setBarcode] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState("");

  async function resolveBarcode(code: string) {
    if (busyRef.current) return;
    if (!isBarcode(code)) {
      setError("Saisissez un code-barres de 8, 12, 13 ou 14 chiffres.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      navigate(await resolveBarcodePath(code));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "La recherche a échoué. Réessayez.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void resolveBarcode(barcode.trim());
  }

  function handleDetected(code: string) {
    setScannerOpen(false);
    setBarcode(code);
    void resolveBarcode(code);
  }

  return <form className={"v2-barcode-search" + (compact ? " v2-barcode-search-compact" : "")} onSubmit={search}>
    <label htmlFor={compact ? "v2-home-barcode" : "v2-catalogue-barcode"}>Rechercher par code-barres</label>
    <div className="v2-barcode-search-row">
      <input id={compact ? "v2-home-barcode" : "v2-catalogue-barcode"} type="text"
        inputMode="numeric" autoComplete="off" value={barcode} disabled={busy}
        onChange={event => { setBarcode(event.target.value); setError(""); }}
        placeholder="EAN / GTIN" aria-describedby={error ? (compact ? "v2-home-barcode-error" : "v2-catalogue-barcode-error") : undefined} />
      <button className="v2-button v2-button-primary" type="submit" disabled={busy}>{busy ? "Recherche…" : "Rechercher"}</button>
      <button className="v2-button v2-button-secondary" type="button" disabled={busy} onClick={() => setScannerOpen(true)}>📷 Scanner</button>
    </div>
    {error && <p id={compact ? "v2-home-barcode-error" : "v2-catalogue-barcode-error"} role="alert">{error}</p>}
    <small>Un code connu ouvre sa fiche ; sinon, il prépare un nouveau produit.</small>
    {scannerOpen && <V2BarcodeScanner onClose={() => setScannerOpen(false)} onDetected={handleDetected} />}
  </form>;
}
