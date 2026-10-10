/**
 * Which parts of a late answer may still land on a record (a bot)
 * when calls on it overlap. Requests are numbered as they start; answers can
 * come back in any order, and the server may apply two writes in the reverse
 * of the order they were sent.
 *
 * - A write's answer sets the fields that write sent, unless a newer write of
 *   the same field already answered.
 * - Its other fields land only when it is the newest answer so far, and never
 *   over a field another write sent: this answer may predate that write.
 * - A read lands whole when it is the newest answer, and ends every claim.
 */
export interface AnswerOrder {
  /** Numbers a call about to start, newer than every earlier one. */
  next(): number;
  /**
   * How a write's answer merges into the record held now, or `null` when none
   * of it may land. The returned function is pure, so it may run inside a
   * state updater.
   */
  write<R extends object>(
    key: string,
    request: number,
    sent: readonly string[],
    answer: R,
  ): ((current: R | undefined) => R) | null;
  /** Whether a read's answer may replace the record. */
  read(key: string, request: number): boolean;
  reset(): void;
}

type Claims = { newest: number; fields: Map<string, number> };

export function createAnswerOrder(): AnswerOrder {
  let sequence = 0;
  const records = new Map<string, Claims>();
  const claimsOf = (key: string) => {
    const claims = records.get(key) ?? { newest: 0, fields: new Map<string, number>() };
    records.set(key, claims);
    return claims;
  };

  return {
    next: () => ++sequence,
    write<R extends object>(key: string, request: number, sent: readonly string[], answer: R) {
      const claims = claimsOf(key);
      const whole = request > claims.newest;
      const taken = sent.filter((field) => request > (claims.fields.get(field) ?? 0));
      if (!whole && taken.length === 0) return null;
      const kept = [...claims.fields.keys()].filter((field) => !taken.includes(field));
      if (whole) claims.newest = request;
      for (const field of taken) claims.fields.set(field, request);
      return (current: R | undefined): R => {
        if (!current) return answer;
        const base = { ...(whole ? answer : current) } as Record<string, unknown>;
        const from = (whole ? current : answer) as Record<string, unknown>;
        for (const field of whole ? kept : taken) {
          if (field in from) base[field] = from[field];
        }
        return base as R;
      };
    },
    read(key, request) {
      const claims = claimsOf(key);
      if (request <= claims.newest) return false;
      claims.newest = request;
      claims.fields.clear();
      return true;
    },
    reset() {
      records.clear();
    },
  };
}
