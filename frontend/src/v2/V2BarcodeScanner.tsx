import { useEffect, useRef, useState } from "react";
import type { IScannerControls } from "@zxing/browser";
import { GTIN_PATTERN } from "./v2-catalogue-search";

type ScannerState = "requesting" | "scanning" | "insecure" | "denied" | "no-camera" | "camera-error";

export default function V2BarcodeScanner({ onClose, onDetected }: {
  onClose: () => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const detectedRef = useRef(false);
  // The parents pass new functions on every render: kept in refs, so that a render of the page behind
  // the dialog does not move the focus back to the close button.
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  const [state, setState] = useState<ScannerState>("requesting");

  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    let active = true;
    let controls: IScannerControls | null = null;
    const video = videoRef.current;

    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState("insecure");
        return;
      }
      try {
        // Load the decoder only when the scanner is opened. The one-dimensional
        // formats avoid matching QR codes printed next to a product's GTIN.
        const [{ BrowserMultiFormatOneDReader }, { BarcodeFormat }] = await Promise.all([
          import("@zxing/browser"), import("@zxing/library"),
        ]);
        if (!active || !video) return;
        const reader = new BrowserMultiFormatOneDReader(undefined, { delayBetweenScanAttempts: 350 });
        reader.possibleFormats = [BarcodeFormat.EAN_8, BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.ITF];
        const started = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false }, video,
          (result, _error, scanControls) => {
            if (!active || !result || detectedRef.current) return;
            const code = result.getText().trim();
            if (!GTIN_PATTERN.test(code)) return;
            detectedRef.current = true;
            scanControls.stop();
            onDetectedRef.current(code);
          },
        );
        if (!active || detectedRef.current) started.stop();
        else { controls = started; setState("scanning"); }
      } catch (error) {
        if (!active) return;
        const name = error instanceof Error ? error.name : "";
        setState(name === "NotAllowedError" || name === "PermissionDeniedError" ? "denied"
          : name === "NotFoundError" || name === "OverconstrainedError" ? "no-camera"
          : "camera-error");
      }
    }

    void start();
    return () => {
      active = false;
      controls?.stop();
      // Also cover a still-pending camera request whose controls have not yet
      // arrived; its eventual controls are stopped by the active check above.
      if (video?.srcObject instanceof MediaStream) {
        video.srcObject.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return <div className="v2-scanner-backdrop" onClick={onClose}>
    <section className="v2-scanner-dialog" role="dialog" aria-modal="true" aria-label="Scanner un code-barres" onClick={event => event.stopPropagation()}>
      <div className="v2-scanner-header">
        <h2>Scanner un code-barres</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Fermer le scanner">×</button>
      </div>
      <div className="v2-scanner-preview" hidden={state !== "requesting" && state !== "scanning"}>
        <video ref={videoRef} autoPlay muted playsInline aria-label="Aperçu de la caméra" />
        <span className="v2-scanner-target" aria-hidden="true" />
      </div>
      {state === "requesting" && <p>Ouverture de la caméra…</p>}
      {state === "scanning" && <p>Placez le code-barres dans le cadre.</p>}
      {state === "insecure" && <p role="alert">La caméra nécessite une connexion sécurisée (HTTPS). Vous pouvez aussi saisir le code manuellement ci-dessous.</p>}
      {state === "denied" && <p role="alert">Accès à la caméra refusé. Autorisez-le dans le navigateur, puis rouvrez le scanner.</p>}
      {state === "no-camera" && <p role="alert">Aucune caméra disponible sur cet appareil.</p>}
      {state === "camera-error" && <p role="alert">Impossible de démarrer la caméra. Fermez le scanner puis réessayez.</p>}
      <button type="button" className="v2-button v2-button-secondary" onClick={onClose}>Saisir le code manuellement</button>
    </section>
  </div>;
}
