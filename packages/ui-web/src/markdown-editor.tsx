import type { MarkdownHistory, MarkdownSelection, MarkdownTextEdit } from "@rakazo/core";
import {
  createMarkdownHistory,
  insertMarkdownLink,
  prefixMarkdownLines,
  recordMarkdownHistory,
  redoMarkdownHistory,
  undoMarkdownHistory,
  wrapMarkdownCode,
  wrapMarkdownSelection,
} from "@rakazo/core";
import { Bold, Code, Heading, Italic, Link, List, ListChecks } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";

export type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
};

function selectionOf(element: HTMLTextAreaElement): MarkdownSelection {
  return { selectionStart: element.selectionStart, selectionEnd: element.selectionEnd };
}

export function MarkdownEditor({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  textareaRef,
}: MarkdownEditorProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  const history = useRef<MarkdownHistory>(
    createMarkdownHistory({ text: value, selectionStart: 0, selectionEnd: 0 }),
  );

  useEffect(() => {
    if (history.current.entries[history.current.index]?.text !== value) {
      history.current = recordMarkdownHistory(history.current, {
        text: value,
        selectionStart: ref.current?.selectionStart ?? 0,
        selectionEnd: ref.current?.selectionEnd ?? 0,
      });
    }
  }, [ref, value]);

  function apply(edit: MarkdownTextEdit) {
    history.current = recordMarkdownHistory(history.current, {
      text: value,
      selectionStart: ref.current?.selectionStart ?? edit.selectionStart,
      selectionEnd: ref.current?.selectionEnd ?? edit.selectionEnd,
    });
    history.current = recordMarkdownHistory(history.current, edit);
    onChange(edit.text);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }

  function restore(nextHistory: MarkdownHistory) {
    if (nextHistory.index === history.current.index) return;
    history.current = nextHistory;
    const edit = nextHistory.entries[nextHistory.index];
    if (!edit) return;
    onChange(edit.text);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }

  function format(kind: "heading" | "bold" | "italic" | "list" | "task" | "link" | "code") {
    const element = ref.current;
    if (!element || disabled) return;
    const selection = selectionOf(element);
    if (kind === "bold") apply(wrapMarkdownSelection(value, selection, "**"));
    if (kind === "heading") apply(prefixMarkdownLines(value, selection, "# "));
    if (kind === "italic") apply(wrapMarkdownSelection(value, selection, "_"));
    if (kind === "list") apply(prefixMarkdownLines(value, selection, "- "));
    if (kind === "task") apply(prefixMarkdownLines(value, selection, "- [ ] "));
    if (kind === "link") apply(insertMarkdownLink(value, selection));
    if (kind === "code") apply(wrapMarkdownCode(value, selection));
  }

  const controls = [
    { kind: "heading" as const, label: "Heading", icon: Heading },
    { kind: "bold" as const, label: "Bold", icon: Bold },
    { kind: "italic" as const, label: "Italic", icon: Italic },
    { kind: "list" as const, label: "List", icon: List },
    { kind: "task" as const, label: "Task list", icon: ListChecks },
    { kind: "link" as const, label: "Link", icon: Link },
    { kind: "code" as const, label: "Code", icon: Code },
  ];

  return (
    <div
      className={cn("overflow-hidden rounded-card border border-input bg-background", className)}
      data-slot="markdown-editor"
    >
      <div
        className="flex items-center gap-0.5 border-b border-border p-1"
        role="toolbar"
        aria-label="Markdown formatting"
      >
        {controls.map(({ kind, label, icon: Icon }) => (
          <Button
            key={kind}
            type="button"
            variant="roundIcon"
            size="roundIconSm"
            aria-label={label}
            title={label}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(kind)}
          >
            <Icon aria-hidden="true" />
          </Button>
        ))}
      </div>
      <Textarea
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          history.current = recordMarkdownHistory(history.current, {
            text: event.target.value,
            selectionStart: event.target.selectionStart,
            selectionEnd: event.target.selectionEnd,
          });
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (!event.metaKey && !event.ctrlKey) return;
          const key = event.key.toLowerCase();
          if (key === "z") {
            event.preventDefault();
            restore(
              event.shiftKey
                ? redoMarkdownHistory(history.current)
                : undoMarkdownHistory(history.current),
            );
          }
          if (key === "y") {
            event.preventDefault();
            restore(redoMarkdownHistory(history.current));
          }
          if (key === "b") {
            event.preventDefault();
            format("bold");
          }
          if (key === "i") {
            event.preventDefault();
            format("italic");
          }
          if (key === "k") {
            event.preventDefault();
            format("link");
          }
        }}
        placeholder={placeholder}
        aria-label="Markdown source"
        dir="auto"
        className="min-h-64 resize-y border-0 bg-transparent font-mono text-body shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
