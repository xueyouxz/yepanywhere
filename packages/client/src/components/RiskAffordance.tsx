import { type ReactNode, useState } from "react";
import { Modal } from "./ui/Modal";

/**
 * The "what's the risk?" affordance shared by the external-session (amber) and
 * pending-tool (blue) banners: a link that reveals a hedged risk explanation on
 * hover (tooltip) and on click (modal). Both banners hang it off their elapsed
 * "… ago" text rather than a separate link, to keep the banner short. The same
 * `explanation` node renders in both the tooltip and the modal.
 */
export function RiskAffordance({
  label,
  labelClassName,
  modalTitle,
  explanation,
}: {
  label: ReactNode;
  labelClassName?: string;
  modalTitle: ReactNode;
  explanation: ReactNode;
}) {
  const [showModal, setShowModal] = useState(false);
  return (
    <span className="external-session-risk">
      <button
        type="button"
        className={`external-session-risk-link${
          labelClassName ? ` ${labelClassName}` : ""
        }`}
        aria-haspopup="dialog"
        onClick={() => setShowModal(true)}
      >
        {label}
      </button>
      <div className="external-session-risk-tooltip" role="tooltip">
        {explanation}
      </div>
      {showModal && (
        <Modal title={modalTitle} onClose={() => setShowModal(false)}>
          {explanation}
        </Modal>
      )}
    </span>
  );
}
