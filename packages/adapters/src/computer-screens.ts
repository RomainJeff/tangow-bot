import type { AdapterContext } from "@tangow/adapter-kit";
import { canReleaseScreenLease, canTakeScreenLease } from "@tangow/core";

export const COMPUTER_SCREEN_UNAVAILABLE =
  "The computer screen is temporarily busy. Retry in a moment. File and shell tools still work.";

export class ComputerScreenUnavailableError extends Error {
  constructor(message = COMPUTER_SCREEN_UNAVAILABLE) {
    super(message);
    this.name = "ComputerScreenUnavailableError";
  }
}

/** A screen, and the browser profile on it, belong to the bot, or to one member's runs of it. */
export function screenSessionKey(context: AdapterContext): string {
  if (!context.botId) return "default";
  return context.memberId ? `${context.botId}:${context.memberId}` : context.botId;
}

export class SingleScreenClaimTracker {
  private readonly owners = new Map<string, { screenKey: string; leaseId?: string }>();

  claim(computerId: string, context: AdapterContext): void {
    const key = screenSessionKey(context);
    const owner = this.owners.get(computerId);
    if (owner && owner.screenKey !== key) {
      throw new ComputerScreenUnavailableError();
    }
    if (owner && !canTakeScreenLease(owner.leaseId, context.screenLeaseId)) {
      if (context.screenLeaseId && owner.leaseId && context.screenLeaseId !== owner.leaseId) {
        throw new ComputerScreenUnavailableError();
      }
    }
    this.owners.set(computerId, {
      screenKey: key,
      leaseId: canTakeScreenLease(owner?.leaseId, context.screenLeaseId)
        ? context.screenLeaseId
        : (owner?.leaseId ?? context.screenLeaseId),
    });
  }

  /** Returns true when this call cleared the in-memory claim. */
  release(computerId: string, context?: AdapterContext): boolean {
    if (!context) {
      this.owners.delete(computerId);
      return true;
    }
    const owner = this.owners.get(computerId);
    if (
      owner?.screenKey === screenSessionKey(context) &&
      canReleaseScreenLease(owner.leaseId, context.screenLeaseId)
    ) {
      this.owners.delete(computerId);
      return true;
    }
    return false;
  }
}

export function isComputerScreenUnavailable(error: unknown): error is Error {
  return (
    error instanceof ComputerScreenUnavailableError ||
    (error instanceof Error && /cannot allocate another screen/i.test(error.message))
  );
}

export async function withComputerScreenAvailability<T>(
  work: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    if (isComputerScreenUnavailable(error)) return { error: error.message };
    throw error;
  }
}
