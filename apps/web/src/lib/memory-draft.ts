export function hasMemoryDraftChanges(
  original: { title: string; content: string } | undefined,
  title: string,
  content: string,
  originalMetadata = "",
  metadata = "",
): boolean {
  return (
    title !== (original?.title ?? "") ||
    content !== (original?.content ?? "") ||
    originalMetadata !== metadata
  );
}
