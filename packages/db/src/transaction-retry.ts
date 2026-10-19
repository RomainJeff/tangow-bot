const RETRYABLE_DATABASE_CODES = new Set(["40001", "40P01"]);

function isRetryableTransactionConflict(error: unknown, retryUniqueViolation: boolean): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const prismaError = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (prismaError.code === "P2034") return true;
  if (retryUniqueViolation && prismaError.code === "P2002") return true;
  const databaseCode = prismaError.meta?.driverAdapterError?.cause?.originalCode;
  return typeof databaseCode === "string" && RETRYABLE_DATABASE_CODES.has(databaseCode);
}

/**
 * Retry serialization conflicts. `retryUniqueViolation` also retries P2002 for idempotency keys
 * claimed by a concurrent attempt; the replay then finds the winner's command.
 */
export async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  options: { retryUniqueViolation?: boolean } = {},
): Promise<T> {
  const maxAttempts = options.retryUniqueViolation ? 5 : 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !isRetryableTransactionConflict(error, options.retryUniqueViolation === true) ||
        attempt >= maxAttempts
      ) {
        throw error;
      }
    }
  }
}
