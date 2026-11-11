import { WorkingLine } from "@tangow/ui-web";
import "./beautiful-ui.css";

/* Beautiful UI primitives — hand-ported from beautifului.dev
   (github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).
   The working beat now composes the shared `WorkingLine` primitive instead of
   its own pixel-grid loader, so only one thing in the product keeps moving
   while something runs; the pop-in success beat below keeps its original
   motion language. */

/** A working state: an indicator (or none), a label, and the elapsed time. */
export function LoadingState({
  indicator,
  label = "working",
  startedAt,
}: {
  indicator?: React.ReactNode;
  label?: string;
  /** Epoch ms when the run started. Falls back to mount time when omitted. */
  startedAt?: number;
}) {
  return <WorkingLine avatar={indicator} label={label} startedAt={startedAt} />;
}

/** Pop-in green check with a fading-up label — the approval-card success beat. */
export function SuccessPop({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-background"
        style={{ animation: "bui-pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <span
        className="text-[13px] font-medium text-foreground"
        style={{ animation: "bui-fade-up 350ms cubic-bezier(0.23,1,0.32,1) 100ms both" }}
      >
        {label}
      </span>
    </span>
  );
}
