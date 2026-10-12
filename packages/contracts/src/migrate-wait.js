/**
 * How long a recreate waits for its services. They start after the one-shot `migrate` service,
 * which on a large database spends minutes moving its conversations into the session log, and
 * Compose counts that wait against the timeout.
 */
export const MIGRATION_WAIT_TIMEOUT_S = 3600;
