import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/** Keep a draft through both client-side navigation and document unload. */
export function useMemoryDraftGuard(changed: boolean, message: string) {
  const saved = useRef(false);
  const blocker = useBlocker(() => changed && !saved.current);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (saved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);
  return () => {
    saved.current = true;
  };
}
