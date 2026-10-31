export function screenLeaseId(runId: string, fence: number): string {
  return `${runId}:${fence}`;
}

export function parseScreenLeaseId(leaseId: string): { ownerId: string; fence: number } {
  const separator = leaseId.lastIndexOf(":");
  if (separator <= 0) return { ownerId: leaseId, fence: 0 };
  const fence = Number(leaseId.slice(separator + 1));
  if (!Number.isInteger(fence) || fence < 0) return { ownerId: leaseId, fence: 0 };
  return { ownerId: leaseId.slice(0, separator), fence };
}

/** A kept screen belongs to no run, so the next run's first claim may match its fence. */
export function canTakeScreenLease(
  existing: string | undefined,
  incoming: string | undefined,
  kept = false,
): boolean {
  if (!incoming) return false;
  if (!existing || existing === incoming) return true;
  const { fence } = parseScreenLeaseId(incoming);
  const current = parseScreenLeaseId(existing).fence;
  return kept ? fence >= current : fence > current;
}

export function canReleaseScreenLease(
  existing: string | undefined,
  incoming: string | undefined,
): boolean {
  if (!incoming || !existing || existing === incoming) return true;
  const current = parseScreenLeaseId(existing);
  const next = parseScreenLeaseId(incoming);
  return next.ownerId === current.ownerId && next.fence >= current.fence;
}
