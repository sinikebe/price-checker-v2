import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { InfoIcon } from "./V2SiteIcons";
import "./v2-info.css";

const EDGE = 8, GAP = 8, HOVER_CLOSE_MS = 150;

/** The bubble open at this moment: opening another one closes it. */
let openBubble: { close: () => void } | null = null;

/**
 * An instruction kept out of the way: a small "i" that shows its text in a bubble, on click or tap, or
 * while a mouse rests on it. The bubble lives under <body>, so no card or scrolling area can cut it off.
 * Closed, its text stays in the page and describes the button, for screen readers and AI agents.
 */
export default function V2Info({ children, label = "Aide", showLabel = false }: {
  children: ReactNode;
  /** The button's name. */
  label?: string;
  /** Writes the name next to the "i", where no title or field gives the bubble its context. */
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  // Opened by a click: stays open when the mouse leaves.
  const pinned = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const self = useRef({ close: () => { pinned.current = false; window.clearTimeout(timer.current); setOpen(false); } });

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    if (openBubble !== self.current) openBubble?.close();
    openBubble = self.current;
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    if (openBubble === self.current) openBubble = null;
    self.current.close();
  }, []);

  useLayoutEffect(() => {
    if (!open || !button.current || !bubble.current) return;
    const anchor = button.current.getBoundingClientRect();
    const box = bubble.current.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const fitsBelow = below + box.height <= window.innerHeight - EDGE;
    const fitsAbove = anchor.top - GAP - box.height >= EDGE;
    bubble.current.style.left = `${Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - EDGE))}px`;
    bubble.current.style.top = `${fitsBelow || !fitsAbove ? below : anchor.top - GAP - box.height}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => !!target && (button.current?.contains(target as Node) || bubble.current?.contains(target as Node));
    const pointerDown = (event: Event) => { if (!inside(event.target)) hide(); };
    const scroll = (event: Event) => { if (!inside(event.target)) hide(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { hide(); button.current?.focus(); } };
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  useEffect(() => hide, [hide]);

  const enter = (event: PointerEvent) => { if (event.pointerType === "mouse") show(); };
  const leave = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && !pinned.current) timer.current = window.setTimeout(hide, HOVER_CLOSE_MS);
  };
  // Inside a label or a summary, the click must only open the bubble.
  const click = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (open && pinned.current) hide();
    else { pinned.current = true; show(); }
  };

  return <>
    <button ref={button} type="button" className={"v2-info-button" + (showLabel ? " v2-info-button-labelled" : "")} aria-label={showLabel ? undefined : label}
      aria-expanded={open} aria-controls={id} aria-describedby={id} onClick={click} onPointerEnter={enter} onPointerLeave={leave}>
      <InfoIcon />{showLabel && <span>{label}</span>}
    </button>
    {createPortal(<div ref={bubble} id={id} role="note" className="v2-info-bubble" hidden={!open}
      onClick={event => event.stopPropagation()} onPointerEnter={enter} onPointerLeave={leave}>{children}</div>, document.body)}
  </>;
}
