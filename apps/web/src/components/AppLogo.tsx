import type { AskDraft } from "@rakazo/contracts";
import { appIcon } from "@rakazo/core";
import { Mail, MessageSquare } from "lucide-react";

/** The app a draft goes through: its catalog logo, else the bundled mark, else a neutral glyph. */
export function AppLogo({ app, chat }: { app: AskDraft["app"]; chat: boolean }) {
  const icon = appIcon(app, chat);
  switch (icon.kind) {
    case "logo":
      return <img src={icon.uri} alt="" className="size-4 shrink-0 rounded-chip object-contain" />;
    case "mark":
      return (
        <svg aria-hidden="true" viewBox={icon.mark.viewBox} className="size-4 shrink-0">
          {icon.mark.shapes.map((shape) => (
            <path
              key={shape.d}
              d={shape.d}
              fill={shape.fill ?? "none"}
              stroke={shape.stroke}
              strokeWidth={shape.strokeWidth}
              strokeLinejoin="round"
            />
          ))}
        </svg>
      );
    case "glyph": {
      const Glyph = icon.glyph === "message" ? MessageSquare : Mail;
      return <Glyph aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
    }
  }
}
