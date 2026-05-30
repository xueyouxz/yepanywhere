import type { MouseEvent } from "react";

interface ViewerCountIndicatorProps {
  className?: string;
  count?: number | null;
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function ViewerCountIndicator({
  className,
  count,
  label,
  onClick,
}: ViewerCountIndicatorProps) {
  const content = (
    <>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="viewer-count-indicator-icon"
      >
        <path d="M4 10a8 8 0 0 1 16 0" />
        <path d="M8 10a4 4 0 0 1 8 0" />
        <path d="M12 10v8" />
        <path d="M9 18h6" />
      </svg>
      {typeof count === "number" && <span>{count}</span>}
    </>
  );
  const classes = `viewer-count-indicator${onClick ? " viewer-count-indicator-button" : ""}${className ? ` ${className}` : ""}`;

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        title={label}
        aria-label={label}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={classes}
      title={label}
      aria-label={label}
    >
      {content}
    </span>
  );
}
