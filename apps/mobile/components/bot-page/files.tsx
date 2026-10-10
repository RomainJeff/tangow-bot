import { useRouter } from "expo-router";
import { useState } from "react";
import { rpc } from "../../lib/api";
import { dateLocaleForUi, t, useI18n } from "../../lib/i18n";
import { LoadFailed, LoadingRows, QuietLine, Row, Separated, useFocusedRead } from "./kit";

type WorkspaceEntry = { path: string; kind: "file" | "dir"; size: number };

function entryName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** Directories first, then files, each alphabetical, so the list is stable. */
function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return entryName(a.path).localeCompare(entryName(b.path));
  });
}

function formatSize(bytes: number): string {
  const kilobytes = bytes / 1024;
  const megabytes = kilobytes >= 1024;
  const value = megabytes ? kilobytes / 1024 : kilobytes;
  const size = new Intl.NumberFormat(dateLocaleForUi(), {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
  return megabytes ? t("{size} MB", { size }) : t("{size} KB", { size });
}

/**
 * The bot's working files at `path`: its computer workspace while it runs,
 * otherwise the last checkpoint. A folder opens on its own screen, a file in a reader.
 */
export function FileList({
  botId,
  path,
  shown,
  epoch,
}: {
  botId: string;
  path: string;
  /** How many entries show before "Show more"; all of them when unset. */
  shown?: number;
  /** A change reads the folder again, as when a run that may have written to it ends. */
  epoch?: number;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const { read, retry } = useFocusedRead(
    async () => sortEntries(await rpc<WorkspaceEntry[]>("computer/files", { botId, path })),
    [botId, path, epoch],
  );
  if (read.kind === "loading") return <LoadingRows />;
  if (read.kind === "failed") return <LoadFailed onRetry={retry} />;
  if (read.value.length === 0) return <QuietLine>{t("No files yet")}</QuietLine>;
  const collapsible = shown !== undefined && read.value.length > shown;
  const entries = collapsible && !expanded ? read.value.slice(0, shown) : read.value;
  return (
    <Separated>
      {entries.map((entry) => (
        <Row
          key={entry.path}
          label={entry.kind === "dir" ? `${entryName(entry.path)}/` : entryName(entry.path)}
          value={entry.kind === "file" ? formatSize(entry.size) : null}
          chevron
          onPress={() =>
            router.push({
              pathname: entry.kind === "dir" ? "/bot-files" : "/bot-file",
              params: { botId, path: entry.path },
            })
          }
        />
      ))}
      {collapsible ? (
        <Row
          label={expanded ? t("Show less") : t("Show more")}
          onPress={() => setExpanded((value) => !value)}
        />
      ) : null}
    </Separated>
  );
}
