interface BrandWordmarkProps {
  className?: string;
  variant?: "short" | "full";
}

export function BrandWordmark({
  className = "",
  variant = "short",
}: BrandWordmarkProps) {
  if (variant === "full") {
    return (
      <span
        className={`brand-wordmark brand-wordmark--full ${className}`.trim()}
      >
        <span className="brand-wordmark__yep">yep</span>
        <span className="brand-wordmark__anywhere">anywhere</span>
      </span>
    );
  }

  return (
    <span className={`brand-wordmark brand-wordmark--short ${className}`.trim()}>
      yep
    </span>
  );
}

export function isYepAnywhereBrandName(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "yepanywhere";
}
