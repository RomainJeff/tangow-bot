const FROM_SERVER = Symbol("fromServer");

/** A refused call carrying the message the server wrote for the person. */
export function serverError(message: string): Error {
  return Object.assign(new Error(message), { [FROM_SERVER]: true });
}

/**
 * The server's own words for a failure, or `""` when the call never got an
 * answer (offline, timed out), so a save shows its reason only when there is one.
 */
export function serverMessage(error: unknown): string {
  return error instanceof Error && FROM_SERVER in error ? error.message : "";
}
