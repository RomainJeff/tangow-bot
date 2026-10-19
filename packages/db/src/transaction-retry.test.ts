import { describe, expect, it } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

const failing = (code: string, failures: number) => {
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls <= failures) throw Object.assign(new Error(code), { code });
    return calls;
  };
  return { operation, calls: () => calls };
};

describe("withTransactionRetry", () => {
  it("retries serialization conflicts but not unique violations by default", async () => {
    await expect(withTransactionRetry(failing("P2034", 2).operation)).resolves.toBe(3);
    const unique = failing("P2002", 1);
    await expect(withTransactionRetry(unique.operation)).rejects.toMatchObject({ code: "P2002" });
    expect(unique.calls()).toBe(1);
  });

  it("retries unique violations up to five attempts when asked", async () => {
    await expect(
      withTransactionRetry(failing("P2002", 4).operation, { retryUniqueViolation: true }),
    ).resolves.toBe(5);
    const exhausted = failing("P2002", 5);
    await expect(
      withTransactionRetry(exhausted.operation, { retryUniqueViolation: true }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(exhausted.calls()).toBe(5);
  });
});
