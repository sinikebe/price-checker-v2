// The legal documents of an installation: their pages, footer links and admin rows are drawn from this
// one list. No imports, so the navigation tests can load it on its own.

export type LegalKind = "mentions" | "confidentialite" | "conditions";

/** The documents in the order the site lists them, with their title and the page that shows them. */
export const LEGAL_DOCUMENTS: readonly { kind: LegalKind; title: string; path: string }[] = [
  { kind: "mentions", title: "Mentions légales", path: "/v2/mentions-legales" },
  { kind: "confidentialite", title: "Confidentialité", path: "/v2/confidentialite" },
  { kind: "conditions", title: "Conditions d’utilisation", path: "/v2/conditions-utilisation" },
];

export const legalDocument = (kind: LegalKind) => LEGAL_DOCUMENTS.find(item => item.kind === kind)!;

/** Markdown read as plain text: heading and emphasis marks removed, each link followed by its address. */
export function plainLegalText(text: string): string[] {
  return text.split(/\n\s*\n/).map(block => block.trim()
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)"))
    .filter(Boolean);
}
