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

/** Fences only order one run's attempts, so a kept screen, which no run owns, goes to any other run. */
export function canTakeScreenLease(
  existing: string | undefined,
  incoming: string | undefined,
  kept = false,
): boolean {
  if (!incoming) return false;
  if (!existing || existing === incoming) return true;
  const next = parseScreenLeaseId(incoming);
  const current = parseScreenLeaseId(existing);
  if (kept && next.ownerId !== current.ownerId) return true;
  return kept ? next.fence >= current.fence : next.fence > current.fence;
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
