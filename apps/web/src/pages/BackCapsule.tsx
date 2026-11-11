import { Button } from "@tangow/ui-web";
import { ChevronLeft } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** The back button of a pushed page: the name of the page it returns to. */
export function BackCapsule({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "children"> & { label: ReactNode }) {
  return (
    <Button
      variant="tertiary"
      size="capsule"
      className={`gap-1 ps-2 ${className ?? ""}`}
      {...props}
    >
      <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {label}
    </Button>
  );
}
