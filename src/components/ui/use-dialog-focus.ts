"use client";

import { type RefObject, useEffect, useRef } from "react";

const DIALOG_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// One stack owns Escape and the page scroll lock, including nested dialogs.
const dialogStack: HTMLElement[] = [];
let pageOverflow = "";

function visibleControls(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE))
    .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled")
      && !element.closest("[inert]") && element.getClientRects().length > 0
      && window.getComputedStyle(element).visibility !== "hidden");
}

/** Focus containment, Escape close and trigger restoration for modal UI. */
export function useDialogFocus(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null> | null,
  onClose: () => void,
  fallbackFocusRef: RefObject<HTMLElement | null> | null = null,
) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const fallbackReturnTarget = fallbackFocusRef?.current ?? null;
    if (!dialogStack.length) pageOverflow = document.body.style.overflow;
    dialogStack.push(dialog);
    document.body.style.overflow = "hidden";
    const originalTabIndex = dialog.getAttribute("tabindex");
    if (originalTabIndex === null) dialog.tabIndex = -1;
    const backdrop = dialog.closest<HTMLElement>(".app-modal-backdrop");
    const viewport = window.visualViewport;
    const updateViewport = () => {
      if (!backdrop || !viewport) return;
      backdrop.style.setProperty("--dialog-viewport-height", `${viewport.height}px`);
      backdrop.style.setProperty("--dialog-viewport-top", `${viewport.offsetTop}px`);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    // Opening a sheet should not summon the phone keyboard before a field is tapped.
    const target = window.matchMedia("(pointer: coarse), (max-width: 760px)").matches
      ? dialog : initialFocusRef?.current ?? visibleControls(dialog)[0] ?? dialog;
    target.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogStack.at(-1) !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = visibleControls(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const outsideControls = !focusable.includes(document.activeElement as HTMLElement);
      if (event.shiftKey && (document.activeElement === first || outsideControls)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outsideControls)) {
        event.preventDefault();
        first.focus();
      }
    };

    // Bubble phase lets a combobox consume Escape before its containing sheet.
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      const wasTop = dialogStack.at(-1) === dialog;
      const index = dialogStack.lastIndexOf(dialog);
      if (index >= 0) dialogStack.splice(index, 1);
      if (!dialogStack.length) document.body.style.overflow = pageOverflow;
      if (originalTabIndex === null) dialog.removeAttribute("tabindex");
      const preferredReturnTarget = returnFocusRef.current;
      // A backgrounded or automation-controlled Chromium page can throttle
      // requestAnimationFrame to roughly one callback per second. Focus
      // restoration only needs to run after this cleanup stack, so a
      // microtask restores keyboard focus promptly without depending on paint.
      queueMicrotask(() => {
        const returnTarget = preferredReturnTarget?.isConnected
          ? preferredReturnTarget
          : fallbackReturnTarget;
        if (!wasTop || !returnTarget?.isConnected) return;
        const top = dialogStack.at(-1);
        if (!top || top.contains(returnTarget)) returnTarget.focus({ preventScroll: true });
      });
    };
  }, [dialogRef, fallbackFocusRef, initialFocusRef, open]);
}
