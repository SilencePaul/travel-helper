import type { Place } from "@travel/contracts";
import { startTransition, useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AttractionDetails } from "./AttractionDetails";
import { RestaurantDetails } from "./RestaurantDetails";
import { buildAmapNavigationUrl } from "../map/navigation";

type PlaceDrawerProps = {
  place: Place;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  mobile?: boolean;
  rainAlternative?: Place;
};

function formatCheckedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

const mobileMediaQuery = "(max-width: 799px)";

function subscribeToMobileViewport(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mediaQuery = window.matchMedia(mobileMediaQuery);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getMobileViewportSnapshot() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(mobileMediaQuery).matches
    : false;
}

export function PlaceDrawer({ place, triggerRef, onClose, mobile = false, rainAlternative }: PlaceDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(true);
  const [mobileState, setMobileState] = useState<"partial" | "full">("partial");
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const viewportIsMobile = useSyncExternalStore(subscribeToMobileViewport, getMobileViewportSnapshot, () => false);
  const isMobile = mobile || viewportIsMobile;
  const navigationUrl = buildAmapNavigationUrl({ ...place.coordinate, name: place.name, mode: "walking" });

  useEffect(() => {
    startTransition(() => setPortalRoot(document.body));
  }, []);

  const close = () => {
    setOpen(false);
    onClose();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const copyAddress = async () => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(place.address);
  };

  useEffect(() => {
    if (!open || !portalRoot) return;
    const dialog = dialogRef.current;
    dialog?.showModal?.();
    if (dialog && !dialog.open) dialog.setAttribute("open", "");
    const focusTarget = dialogRef.current?.querySelector<HTMLElement>("button, a[href]");
    focusTarget?.focus();
    const appRoot = document.getElementById("root");
    const previousOverflow = document.body.style.overflow;
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    appRoot?.setAttribute("inert", "");
    appRoot?.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "hidden";
    return () => {
      if (dialog?.open) dialog.close?.();
      dialog?.removeAttribute("open");
      if (appRoot) {
        appRoot.removeAttribute("inert");
        if (previousAriaHidden === null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", previousAriaHidden);
      }
      document.body.style.overflow = previousOverflow;
    };
  }, [open, portalRoot]);

  if (!open || !portalRoot) return null;
  const communitySource = place.sources.find((source) => source.kind === "community");
  const focusableSelector = "button:not([disabled]), a[href]";

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`place-drawer${isMobile ? " place-drawer-mobile" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-drawer-state={isMobile ? mobileState : "full"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== "Tab") return;
        const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
        if (elements.length === 0) return;
        const first = elements[0]!;
        const last = elements[elements.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="place-drawer-handle" aria-hidden="true" />
      <header className="place-drawer-header">
        <div>
          <p className="eyebrow">{place.type === "restaurant" ? "餐饮" : "景点"}</p>
          <h2 id={titleId}>{place.name}</h2>
        </div>
        <button type="button" className="drawer-close" onClick={close} aria-label="关闭详情">×</button>
      </header>
      {isMobile ? <button type="button" className="drawer-expand" onClick={() => setMobileState((state) => state === "partial" ? "full" : "partial")} aria-label={mobileState === "partial" ? "展开详情" : "收起详情"}>{mobileState === "partial" ? "展开详情" : "收起详情"}</button> : null}
      <div className="place-drawer-content">
        <img className="place-image" src={place.images[0]!.url} alt={place.images[0]!.alt} />
        <p className="place-image-credit">图片：{place.images[0]!.licenseOrOwner}</p>
        <p className="place-summary">{place.summary}</p>
        {place.type === "restaurant" ? <RestaurantDetails place={place} /> : <AttractionDetails place={place} rainAlternative={rainAlternative} />}
        <div className="place-links">
          <a className="place-action primary" href={navigationUrl} target="_blank" rel="noreferrer">开始导航</a>
          <button type="button" className="place-action" onClick={() => void copyAddress()}>复制地址</button>
          {communitySource ? <a className="place-action" href={communitySource.url} target="_blank" rel="noreferrer">小红书搜索</a> : null}
        </div>
        <section className="place-detail-section" aria-labelledby="place-sources">
          <h3 id="place-sources">资料来源</h3>
          <ul className="place-sources">
            {place.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label} · {formatCheckedAt(source.checkedAt)}</a></li>)}
          </ul>
        </section>
      </div>
    </dialog>,
    portalRoot,
  );
}
