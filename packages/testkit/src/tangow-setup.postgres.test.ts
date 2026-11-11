import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb } from "@tangow/db";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const withDatabase = process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

withDatabase("Tangow public signup policy", () => {
  it("initializes a fresh deployment and replaces the loopback policy while preserving other settings", async () => {
    if (!databaseUrl) throw new Error("This integration test requires its isolated database.");
    const { prisma, pool } = createDb(databaseUrl);
    const apply = () =>
      execFileSync(process.execPath, ["--import", "tsx", "scripts/tangow-signup-policy.mjs"], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SIGNUPS_ENABLED: "true",
          SIGNUP_ALLOWLIST: "Owner@Example.test, @Company.test",
        },
        stdio: "pipe",
      });
    const select = {
      signupsEnabled: true,
      signupAllowlist: true,
      signupPolicyInitialized: true,
      defaultModelId: true,
    };
    try {
      apply();
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" }, select }),
      ).toEqual({
        signupsEnabled: true,
        signupAllowlist: "owner@example.test,@company.test",
        signupPolicyInitialized: true,
        defaultModelId: null,
      });
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { signupAllowlist: "", defaultModelId: "preserved-model" },
      });
      apply();
      expect(
        await prisma.deploymentSettings.findUnique({ where: { id: "default" }, select }),
      ).toEqual({
        signupsEnabled: true,
        signupAllowlist: "owner@example.test,@company.test",
        signupPolicyInitialized: true,
        defaultModelId: "preserved-model",
      });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
