/**
 * The clock a message shows, beside its author or on hover: hours and minutes in
 * the reader's locale, from the ISO stamp the thread stores.
 */
export function messageTimeLabel(createdAt: string, locale: string): string {
  return new Date(createdAt).toLocaleTimeString(locale || "en", {
    hour: "numeric",
    minute: "2-digit",
  });
}
