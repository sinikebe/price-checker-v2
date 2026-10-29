import { useState } from "react";
import "./v2-share.css";

export default function V2ShareButton({ title, url, disabled = false }: {
  title: string; url: string | null; disabled?: boolean;
}) {
  const [message, setMessage] = useState("");
  async function share() {
    if (!url) return;
    setMessage("");
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Lien copié");
    } catch {
      setMessage("Copie impossible sur cet appareil");
    }
  }
  return <span className="v2-share-control">
    <button type="button" className="v2-share-button" onClick={() => void share()} disabled={disabled || !url} title={disabled ? "Rien à partager" : "Partager un lien"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
      </svg>
      Partager
    </button>
    <span className="v2-share-feedback" role="status">{message}</span>
  </span>;
}
