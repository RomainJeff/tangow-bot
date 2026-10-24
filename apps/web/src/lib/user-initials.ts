/** Up to two capitals from a person's name, for their avatar without a photo. */
export function userInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
