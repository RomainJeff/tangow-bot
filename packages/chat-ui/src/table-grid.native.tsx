import type { ColorTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";
import {
  Linking,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { linkUnderline } from "./link-underline";
import { linkHref } from "./markdown";
import type { TableNode } from "./table-layout";
import {
  firstColumnNumbersRows,
  plainText,
  TABLE_CELL_PADDING_X,
  tableColumnWidths,
  tableRows,
} from "./table-layout";

/** A markdown AST node as the table views read it. */
export interface GridNode extends TableNode {
  key?: string;
  attributes?: { href?: string };
  children?: readonly GridNode[];
}

/**
 * What a host screen lets a table do: open it whole, with the names a screen
 * reader announces. Without a provider a table is shown but not openable.
 */
export interface TableActions {
  open: (table: GridNode) => void;
  /** Screen-reader name of a compact table, e.g. "Table, 5 rows". */
  label: (rowCount: number) => string;
  /** Screen-reader hint: what a tap does. */
  hint: string;
}

const TableActionsContext = createContext<TableActions | null>(null);
export const TableActionsProvider = TableActionsContext.Provider;

function Inline({
  nodes,
  palette,
  onLinkPress,
}: {
  nodes: readonly GridNode[] | undefined;
  palette: ColorTokens;
  onLinkPress?: (url: string) => void;
}): ReactNode {
  return (nodes ?? []).map((node, index) => {
    const key = node.key ?? String(index);
    const children = (
      <Inline key={key} nodes={node.children} palette={palette} onLinkPress={onLinkPress} />
    );
    switch (node.type) {
      case "text":
        return node.content ?? "";
      case "softbreak":
        return " ";
      case "hardbreak":
        return "\n";
      case "strong":
        return (
          <Text key={key} style={styles.strong}>
            {children}
          </Text>
        );
      case "em":
        return (
          <Text key={key} style={styles.em}>
            {children}
          </Text>
        );
      case "s":
        return (
          <Text key={key} style={styles.strike}>
            {children}
          </Text>
        );
      case "code_inline":
        return (
          <Text key={key} style={[styles.code, { backgroundColor: palette.muted }]}>
            {node.content}
          </Text>
        );
      case "link":
        return (
          <Text
            key={key}
            style={{
              textDecorationLine: "underline",
              textDecorationColor: linkUnderline(palette.foreground),
            }}
            onPress={onLinkPress ? () => onLinkPress(node.attributes?.href ?? "") : undefined}
          >
            {children}
          </Text>
        );
      default:
        return <Text key={key}>{children}</Text>;
    }
  });
}

/** Links in a table come from a bot's untrusted output: only safe targets open. */
function onLinkPress(url: string) {
  const safeUrl = linkHref(url);
  if (safeUrl) Linking.openURL(safeUrl).catch(() => {});
}

function cellsOf(row: TableNode): readonly GridNode[] {
  return ((row.children ?? []) as readonly GridNode[]).filter(
    (cell) => cell.type === "th" || cell.type === "td",
  );
}

/**
 * A markdown table the way phones read it (Notion, chat apps): compact rows,
 * columns sized to their content, cells clamped so a row stays short, and a
 * sideways scroll past the host's edge. When the host provides actions, a tap
 * opens the whole table as records.
 */
export function TableGrid({
  table,
  palette,
  inset,
}: {
  table: GridNode;
  palette: ColorTokens;
  /** Horizontal inset of the first column, so it lines up with the host's text. */
  inset: number;
}) {
  const actions = useContext(TableActionsContext);
  const scroll = useRef<ScrollView>(null);
  const rows = tableRows(table);
  const widths = tableColumnWidths(table, undefined, PixelRatio.getFontScale());
  // Wide tables keep two lines per cell so a row stays short; the full text is in the records.
  const lines = widths.length > 3 ? 2 : 3;
  const bodyRows = rows.filter((row) => cellsOf(row).some((cell) => cell.type === "td"));

  useEffect(() => {
    // Shows once that the table scrolls sideways, as iOS does for a fresh scroll view.
    const timer = setTimeout(() => scroll.current?.flashScrollIndicators(), 400);
    return () => clearTimeout(timer);
  }, []);

  const rowViews = (
    <View>
      {rows.map((row, rowIndex) => {
        const last = rowIndex === rows.length - 1;
        return (
          <View
            key={(row as GridNode).key ?? String(rowIndex)}
            style={[
              styles.row,
              !last && { borderBottomWidth: StyleSheet.hairlineWidth },
              { borderBottomColor: palette.border },
            ]}
          >
            {cellsOf(row).map((cell, index) => {
              const header = cell.type === "th";
              return (
                <View
                  key={cell.key ?? String(index)}
                  style={[styles.cell, { width: widths[index] }]}
                >
                  <Text
                    numberOfLines={header ? 2 : lines}
                    style={
                      header
                        ? [styles.headerText, { color: palette.mutedForeground }]
                        : [styles.cellText, { color: palette.foreground }]
                    }
                  >
                    <Inline nodes={cell.children} palette={palette} />
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );

  // The tap target sits inside the scroll view, not around it: wrapped
  // outside, it claimed the touch and the table could not scroll sideways.
  // Inside, a sideways drag scrolls and cancels the tap.
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator
      contentContainerStyle={{ paddingHorizontal: inset }}
    >
      {actions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actions.label(bodyRows.length)}
          accessibilityHint={actions.hint}
          onPress={() => actions.open(table)}
          // A thumb scrolling the thread past the table does not dim it.
          unstable_pressDelay={130}
          style={({ pressed }) => (pressed ? styles.pressed : undefined)}
        >
          {rowViews}
        </Pressable>
      ) : (
        rowViews
      )}
    </ScrollView>
  );
}

/**
 * The whole table as records, how Notion and iOS lay out rows on a phone: one
 * section per row, its first cell as the title and every other column as a
 * label over its value. Nothing scrolls sideways and nothing is clamped.
 */
export function TableRecords({ table, palette }: { table: GridNode; palette: ColorTokens }) {
  const rows = tableRows(table);
  const headerRow = rows.find((row) => cellsOf(row).every((cell) => cell.type === "th"));
  const labels = headerRow ? cellsOf(headerRow) : [];
  const records = rows.filter((row) => row !== headerRow);
  // A first column that only numbers the rows ("#", "1", "2") titles nothing on
  // its own: the record is then titled "1. <second column>".
  const numbered = firstColumnNumbersRows(records);
  const skip = numbered ? 2 : 1;
  return (
    <View>
      {records.map((row, rowIndex) => {
        const cells = cellsOf(row);
        const title = numbered ? cells[1] : cells[0];
        return (
          <View
            key={(row as GridNode).key ?? String(rowIndex)}
            style={[
              styles.record,
              rowIndex > 0 && { borderTopWidth: StyleSheet.hairlineWidth },
              { borderTopColor: palette.border },
            ]}
          >
            {title ? (
              <Text style={[styles.recordTitle, { color: palette.foreground }]}>
                {numbered ? (
                  <Text style={{ color: palette.mutedForeground }}>
                    {`${plainText(cells[0] ?? { type: "td" })
                      .trim()
                      .replace(/\.$/, "")}. `}
                  </Text>
                ) : null}
                <Inline nodes={title.children} palette={palette} onLinkPress={onLinkPress} />
              </Text>
            ) : null}
            {cells.slice(skip).map((cell, index) => {
              const label = labels[index + skip];
              return (
                <View key={cell.key ?? String(index)} style={styles.field}>
                  {label ? (
                    <Text style={[styles.fieldLabel, { color: palette.mutedForeground }]}>
                      <Inline nodes={label.children} palette={palette} />
                    </Text>
                  ) : null}
                  <Text style={[styles.fieldValue, { color: palette.foreground }]}>
                    <Inline nodes={cell.children} palette={palette} onLinkPress={onLinkPress} />
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
  },
  cell: {
    paddingHorizontal: TABLE_CELL_PADDING_X,
    paddingVertical: 8,
  },
  cellText: {
    fontSize: 14,
    lineHeight: 20,
  },
  headerText: {
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: "500",
  },
  pressed: {
    opacity: 0.6,
  },
  record: {
    paddingVertical: 16,
    gap: 10,
  },
  recordTitle: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  field: {
    gap: 2,
  },
  fieldLabel: {
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: "500",
  },
  fieldValue: {
    fontSize: 15,
    lineHeight: 22,
  },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  code: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 12.5,
  },
});
