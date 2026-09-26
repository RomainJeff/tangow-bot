/** Only an internal review route can be translated into native navigation. */
export function memoryReviewLink(
  url: string,
): { documentId: string; classificationId: string } | null {
  if (!url.startsWith("/app/memory?") && !url.startsWith("/memory-detail?")) return null;
  const parsed = new URL(url, "https://internal.invalid");
  if (!["/app/memory", "/memory-detail"].includes(parsed.pathname) || parsed.hash) return null;
  const documentId = parsed.searchParams.get(
    parsed.pathname === "/app/memory" ? "memory" : "documentId",
  );
  const classificationId = parsed.searchParams.get(
    parsed.pathname === "/app/memory" ? "classification" : "classificationId",
  );
  const validId = /^[a-zA-Z0-9_-]{1,128}$/;
  return documentId &&
    classificationId &&
    validId.test(documentId) &&
    validId.test(classificationId)
    ? { documentId, classificationId }
    : null;
}
