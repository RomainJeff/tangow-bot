import { ArrowUp, Check } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

export interface OptionFieldProps extends ComponentPropsWithoutRef<"input"> {
  /** The answer on its way: the field takes the user's bubble colour. */
  filled?: boolean;
  /** The send button's accessible name. */
  sendLabel: string;
  canSend: boolean;
  onSend: () => void;
  /** A step of several questions: the button confirms this answer, it sends nothing yet. */
  confirms?: boolean;
}

/** A typed answer of a question card: an option tile's shape, holding a field and its send. */
export function OptionField({
  filled,
  sendLabel,
  canSend,
  onSend,
  confirms,
  className,
  ...props
}: OptionFieldProps) {
  const Icon = confirms ? Check : ArrowUp;
  return (
    <form
      data-slot="option-field"
      className={cn(
        "flex min-h-13 items-center gap-2 rounded-card py-2 ps-4 pe-2 ring-1 ring-option-ring-hover focus-within:ring-selected focus-within:ring-foreground",
        filled && "bg-chat-user text-chat-user-foreground ring-0 duration-(--duration-fill)",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <input
        dir="auto"
        className="min-w-0 flex-1 bg-transparent text-question outline-none placeholder:text-muted-foreground"
        {...props}
      />
      <Button
        type="submit"
        variant="roundIcon"
        size="roundIconSm"
        aria-label={sendLabel}
        disabled={!canSend}
        className="bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:opacity-85"
      >
        <Icon size={16} strokeWidth={2} />
      </Button>
    </form>
  );
}
