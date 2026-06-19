import type { ReactNode, Ref } from "react";

interface MainContentProps {
  children: ReactNode;
  isWideScreen: boolean;
  className?: string;
  innerClassName?: string;
  innerRef?: Ref<HTMLDivElement>;
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function MainContent({
  children,
  isWideScreen,
  className,
  innerClassName,
  innerRef,
}: MainContentProps) {
  return (
    <div
      className={classNames(
        isWideScreen ? "main-content-wrapper" : "main-content-mobile",
        className,
      )}
    >
      <div
        ref={innerRef}
        className={classNames(
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner",
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
