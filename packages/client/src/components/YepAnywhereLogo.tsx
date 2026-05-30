import { BrandWordmark } from "./BrandWordmark";

/**
 * YepAnywhereLogo - Brand logo component with dark/light mode support.
 *
 * Displays the full yepanywhere wordmark with the app icon.
 * Automatically adapts colors based on current theme.
 */

interface YepAnywhereLogoProps {
  /** Show compact version (icon + text) vs just text */
  showIcon?: boolean;
  /** Additional className for styling */
  className?: string;
}

export function YepAnywhereLogo({
  showIcon = true,
  className = "",
}: YepAnywhereLogoProps) {
  return (
    <span className={`yep-anywhere-logo ${className}`}>
      {showIcon && (
        <svg
          viewBox="0 0 120 120"
          className="yep-anywhere-logo-icon"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="yepIconGrad"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="var(--app-yep-green)" />
              <stop offset="100%" stopColor="var(--app-yep-green-dark)" />
            </linearGradient>
          </defs>
          <rect
            x="0"
            y="0"
            width="120"
            height="120"
            rx="26"
            fill="url(#yepIconGrad)"
          />
          <path
            d="M 28 35 L 50 62 L 92 20"
            fill="none"
            stroke="#ffffff"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M 50 62 L 50 95"
            fill="none"
            stroke="#ffffff"
            strokeWidth="10"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span className="yep-anywhere-logo-text">
        <BrandWordmark variant="full" />
      </span>
    </span>
  );
}
