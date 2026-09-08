"use client";

import type { ComponentPropsWithoutRef } from "react";
import { createPortal } from "react-dom";

/** Mount overlays outside scrolling/transformed panels, retaining company theme tokens. */
export function ModalBackdrop({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  const overlay = <div {...props} className={`${className ?? ""} app-modal-backdrop`} />;
  // These dialogs mount on user interaction; the fallback also supports server rendering.
  if (typeof document === "undefined") return overlay;
  return createPortal(overlay, document.querySelector("[data-company]") ?? document.body);
}
