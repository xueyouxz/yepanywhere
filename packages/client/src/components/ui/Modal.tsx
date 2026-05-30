import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

const ANCHORED_MODAL_MARGIN_PX = 8;
const ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX = 600;

export interface ModalAnchorRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  anchorRect?: ModalAnchorRect | null;
}

/**
 * Reusable modal component with overlay, header, and scrollable content area.
 * Renders via portal to avoid event bubbling issues.
 * Closes on Escape key or clicking the overlay.
 */
export function Modal({ title, children, onClose, anchorRect }: ModalProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayPointerStartedOnOverlayRef = useRef(false);
  const isAnchored =
    !!anchorRect &&
    typeof window !== "undefined" &&
    window.innerWidth > ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX;
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Focus the close button on mount for accessibility
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!isAnchored || !anchorRect) {
      setAnchorStyle(null);
      return;
    }

    const updateAnchorPosition = () => {
      const modal = modalRef.current;
      if (!modal) return;

      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const modalWidth = Math.min(
        modal.offsetWidth,
        viewportWidth - ANCHORED_MODAL_MARGIN_PX * 2,
      );
      const modalHeight = Math.min(
        modal.offsetHeight,
        viewportHeight - ANCHORED_MODAL_MARGIN_PX * 2,
      );
      const maxLeft = viewportWidth - modalWidth - ANCHORED_MODAL_MARGIN_PX;
      let left = anchorRect.right - modalWidth;
      left = Math.min(Math.max(ANCHORED_MODAL_MARGIN_PX, left), maxLeft);

      let top = anchorRect.bottom + ANCHORED_MODAL_MARGIN_PX;
      if (top + modalHeight > viewportHeight - ANCHORED_MODAL_MARGIN_PX) {
        top = anchorRect.top - modalHeight - ANCHORED_MODAL_MARGIN_PX;
      }
      top = Math.max(ANCHORED_MODAL_MARGIN_PX, top);

      setAnchorStyle({
        left,
        maxHeight: viewportHeight - ANCHORED_MODAL_MARGIN_PX * 2,
        top,
        visibility: "visible",
      });
    };

    updateAnchorPosition();
    window.addEventListener("resize", updateAnchorPosition);
    window.visualViewport?.addEventListener("resize", updateAnchorPosition);
    return () => {
      window.removeEventListener("resize", updateAnchorPosition);
      window.visualViewport?.removeEventListener("resize", updateAnchorPosition);
    };
  }, [anchorRect, isAnchored]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Only close if the whole click started and ended on the overlay.
    // Text selection can start inside the dialog and release outside it.
    if (
      e.target === e.currentTarget &&
      overlayPointerStartedOnOverlayRef.current
    ) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    overlayPointerStartedOnOverlayRef.current = false;
  };

  const handleModalClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent overlay click handler
    e.stopPropagation();
  };

  const modalContent = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally, click is for overlay dismiss
    <div
      className={`modal-overlay${isAnchored ? " modal-overlay--anchored" : ""}`}
      onClick={handleOverlayClick}
      onMouseDown={(e) => {
        overlayPointerStartedOnOverlayRef.current =
          e.target === e.currentTarget;
        e.stopPropagation();
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <div
        ref={modalRef}
        className={`modal${isAnchored ? " modal--anchored" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={handleModalClick}
        style={
          isAnchored
            ? (anchorStyle ?? { visibility: "hidden" })
            : undefined
        }
      >
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="modal-close"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            aria-label={t("modalClose")}
          >
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}
