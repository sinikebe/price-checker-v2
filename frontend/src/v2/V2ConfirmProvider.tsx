import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ConfirmContext, type ConfirmOptions } from "./useConfirm";
import "./v2-confirm.css";

type Pending = ConfirmOptions & { resolve: (value: boolean) => void };

/** Shows the confirmation asked with useConfirm() as a dialog inside the page. */
export function V2ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId(), messageId = useId();

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => {
    current.current?.resolve(false); // a newer question replaces an unanswered one
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = { ...options, resolve };
    current.current = next;
    setPending(next);
  }), []);

  const answer = useCallback((value: boolean) => {
    const asked = current.current;
    if (!asked) return;
    current.current = null;
    setPending(null);
    asked.resolve(value);
    // Back where the person was, when that place is still in the page.
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) window.setTimeout(() => back.focus(), 0);
  }, []);

  useEffect(() => {
    if (!pending) return;
    dialog.current?.querySelector<HTMLButtonElement>("[data-confirm-default]")?.focus();
  }, [pending]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); answer(false); return; }
    if (event.key !== "Tab") return;
    // Keep the focus on the two buttons while the question is open.
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
  }

  return <ConfirmContext.Provider value={confirm}>
    {children}
    {pending && <div className="v2-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) answer(false); }}>
      <div ref={dialog} className="v2-confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}
        data-danger={pending.danger ? "true" : undefined} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{pending.title ?? "Confirmer"}</h2>
        <div id={messageId}>{pending.message.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
        <div className="v2-confirm-actions">
          <button type="button" className="v2-button v2-button-secondary" data-confirm-default={pending.danger ? "" : undefined}
            onClick={() => answer(false)}>{pending.cancelLabel ?? "Annuler"}</button>
          <button type="button" className={"v2-button " + (pending.danger ? "v2-confirm-danger" : "v2-button-primary")}
            data-confirm-default={pending.danger ? undefined : ""} onClick={() => answer(true)}>{pending.confirmLabel ?? "Confirmer"}</button>
        </div>
      </div>
    </div>}
  </ConfirmContext.Provider>;
}
