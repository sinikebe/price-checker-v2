/** The browser extension's files, bundled so the settings page can hand them out as one zip. */
import manifest from "../../browser-extension/manifest.json?raw";
import popupHtml from "../../browser-extension/popup.html?raw";
import popupCss from "../../browser-extension/popup.css?raw";
import popupJs from "../../browser-extension/popup.js?raw";
import contentJs from "../../browser-extension/content.js?raw";
import parseJs from "../../browser-extension/carrefour-parse.js?raw";

export const EXTENSION_FILES: readonly { name: string; text: string }[] = [
  { name: "manifest.json", text: manifest }, { name: "popup.html", text: popupHtml }, { name: "popup.css", text: popupCss },
  { name: "popup.js", text: popupJs }, { name: "content.js", text: contentJs }, { name: "carrefour-parse.js", text: parseJs },
];

/** What the zip holds: the extension plus the address of this instance, so the popup can fill it in. */
export function extensionBundle(instance: string): { name: string; text: string }[] {
  return [...EXTENSION_FILES, { name: "instance.json", text: JSON.stringify({ instance }) + "\n" }];
}
