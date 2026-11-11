import type { GridNode } from "@tangow/chat-ui/native";
import { TableRecords } from "@tangow/chat-ui/native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { PreviewSheet } from "./preview-sheet";

/**
 * A markdown table opened whole: every row as a record (its first cell as the
 * title, each other column as a label over its value), so nothing on a phone
 * scrolls sideways or is cut.
 */
export function TablePreview({ table, onClose }: { table: GridNode; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <PreviewSheet title={t("Table")} onClose={onClose}>
      <TableRecords table={table} palette={mobileTokens()} />
    </PreviewSheet>
  );
}
