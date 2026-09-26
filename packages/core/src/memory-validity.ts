/** Memory day pickers use UTC dates; untouched timestamps retain their precision. */
export function memoryDateInput(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? "";
}

export function memoryDateValue(
  value: string,
  original: string | null | undefined,
  boundary: "start" | "end",
): string | null {
  if (!value) return null;
  if (value === memoryDateInput(original)) return original ?? null;
  return `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`;
}
