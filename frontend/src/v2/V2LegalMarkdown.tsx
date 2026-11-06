import { useEffect, useState, type ComponentType } from "react";
import { plainLegalText } from "./v2-legal-documents";

type Renderer = ComponentType<{ children: string }>;

// The Markdown renderer is loaded with the first legal text, outside the main bundle, and the service worker
// precaches its chunk like every other one. A failed load (a network blip, or a tab without the service
// worker left open across an update whose old chunk is gone) stays failed until the page is reloaded:
// browsers keep a failed module import for the page's lifetime. The text is then shown as plain paragraphs,
// so a legal document is always readable.
let loaded: Renderer | null = null;
let loading: Promise<Renderer> | null = null;

function loadRenderer(): Promise<Renderer> {
  loading ??= import("react-markdown").then(module => (loaded = module.default as Renderer));
  return loading;
}

/** A legal document's Markdown, rendered once its renderer is loaded. */
export default function V2LegalMarkdown({ text }: { text: string }) {
  const [state, setState] = useState<{ renderer: Renderer | null; failed: boolean }>(() => ({ renderer: loaded, failed: false }));
  useEffect(() => {
    if (state.renderer || state.failed) return;
    let active = true;
    loadRenderer().then(
      renderer => { if (active) setState({ renderer, failed: false }); },
      () => { if (active) setState({ renderer: null, failed: true }); },
    );
    return () => { active = false; };
  }, [state]);
  const Markdown = state.renderer;
  if (Markdown) return <Markdown>{text}</Markdown>;
  if (state.failed) return <div className="v2-legal-plain">{plainLegalText(text).map((block, index) => <p key={index}>{block}</p>)}</div>;
  return <p>Chargement des informations légales…</p>;
}
