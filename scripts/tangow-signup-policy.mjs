import { signupPolicyFromEnv } from "../packages/core/src/signup-policy.ts";
import { createDb } from "../packages/db/src/client.ts";

async function main() {
  const { prisma, pool } = createDb(process.env.DATABASE_URL);
  try {
    const policy = signupPolicyFromEnv({
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: This administrative script runs outside Turbo.
      signupsEnabled: process.env.SIGNUPS_ENABLED,
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: This administrative script runs outside Turbo.
      signupAllowlist: process.env.SIGNUP_ALLOWLIST,
    });
    if (!policy.allowlist.length) throw new Error("Public setup requires a signup allowlist.");
    const data = {
      signupsEnabled: policy.enabled,
      signupAllowlist: policy.allowlist.join(","),
      signupPolicyInitialized: true,
    };
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(() => {
  console.error(
    "Cannot apply the public signup policy. Check the database and setup configuration.",
  );
  process.exitCode = 1;
});
