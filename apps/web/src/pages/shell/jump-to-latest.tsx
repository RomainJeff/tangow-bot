import { useLingui } from "@lingui/react/macro";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

export function JumpToLatest({ atEnd, onJump }: { atEnd: boolean; onJump: () => void }) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={t`Jump to latest`}
      aria-hidden={atEnd}
      tabIndex={atEnd ? -1 : 0}
      onClick={onJump}
      className={`rk-glass-control rk-thread-jump absolute left-1/2 z-20 grid size-capsule -translate-x-1/2 place-items-center rounded-full text-foreground transition-[opacity,transform] duration-(--duration-hover) ease-quiet motion-reduce:transition-none ${
        atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
      }`}
    >
      <ArrowDown size={17} strokeWidth={1.8} />
    </button>
  );
}
