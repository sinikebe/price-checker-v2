/** The browser extension's files, bundled so the settings page can hand them out as one zip. */
import manifest from "../../browser-extension/manifest.json?raw";
import popupHtml from "../../browser-extension/popup.html?raw";
import popupCss from "../../browser-extension/popup.css?raw";
import popupJs from "../../browser-extension/popup.js?raw";
import contentJs from "../../browser-extension/content.js?raw";
import parseJs from "../../browser-extension/carrefour-parse.js?raw";
import coreJs from "../../browser-extension/extension-core.js?raw";
import bridgeJs from "../../browser-extension/app-bridge.js?raw";
import backgroundJs from "../../browser-extension/background.js?raw";
import { instanceManifest } from "./v2-extension-manifest";

export const EXTENSION_FILES: readonly { name: string; text: string }[] = [
  { name: "manifest.json", text: manifest }, { name: "popup.html", text: popupHtml }, { name: "popup.css", text: popupCss },
  { name: "popup.js", text: popupJs }, { name: "content.js", text: contentJs }, { name: "carrefour-parse.js", text: parseJs },
  { name: "extension-core.js", text: coreJs }, { name: "app-bridge.js", text: bridgeJs }, { name: "background.js", text: backgroundJs },
];

/** What the zip holds: the extension, its manifest naming this instance, and the address for the popup. */
export function extensionBundle(instance: string): { name: string; text: string }[] {
  return [
    ...EXTENSION_FILES.map(file => file.name === "manifest.json" ? { name: file.name, text: instanceManifest(file.text, instance) } : file),
    { name: "instance.json", text: JSON.stringify({ instance }) + "\n" },
  ];
}
