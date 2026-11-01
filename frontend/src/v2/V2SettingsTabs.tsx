import { useEffect, useRef, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import {
  nextTabIndex, settingsPanelDomId, settingsTabDomId, settingsTabPath, type SettingsTab, type SettingsTabId,
} from "./v2-settings-tabs";
import "./v2-settings-tabs.css";

/** Tab list whose tabs are real links, so each section has its own address. Focus follows the arrow keys; Enter or Space opens a tab. */
export default function V2SettingsTabs({ tabs, activeId }: { tabs: SettingsTab[]; activeId: SettingsTabId }) {
  const elements = useRef(new Map<SettingsTabId, HTMLAnchorElement>());
  useEffect(() => {
    elements.current.get(activeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (event.key === " ") { event.preventDefault(); event.currentTarget.click(); return; }
    const next = nextTabIndex(index, event.key, tabs.length);
    if (next === null) return;
    event.preventDefault();
    elements.current.get(tabs[next].id)?.focus();
  }

  return <div className="v2-settings-tabs" role="tablist" aria-label="Sections des paramètres">
    {tabs.map((tab, index) => {
      const selected = tab.id === activeId;
      return <Link key={tab.id} id={settingsTabDomId(tab.id)} role="tab" className="v2-settings-tab"
        aria-selected={selected} aria-controls={settingsPanelDomId(tab.id)} tabIndex={selected ? 0 : -1}
        to={settingsTabPath(tab.id)}
        ref={element => { if (element) elements.current.set(tab.id, element); else elements.current.delete(tab.id); }}
        onKeyDown={event => onKeyDown(event, index)}>{tab.label}</Link>;
    })}
  </div>;
}
