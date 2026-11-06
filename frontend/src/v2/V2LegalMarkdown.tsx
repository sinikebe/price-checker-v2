import { Suspense, lazy } from "react";

const UNAVAILABLE = <p role="alert">Les informations légales de cette instance sont indisponibles.</p>;

// The Markdown renderer is loaded with the first legal text, outside the main bundle. The service worker
// precaches its chunk like every other one; should it still fail to load, the text is said unavailable.
const ReactMarkdown = lazy(() => import("react-markdown").catch(() => ({ default: () => UNAVAILABLE })));

/** A legal document's Markdown, rendered once its renderer is loaded. */
export default function V2LegalMarkdown({ text }: { text: string }) {
  return <Suspense fallback={<p>Chargement des informations légales…</p>}><ReactMarkdown>{text}</ReactMarkdown></Suspense>;
}
