import { appendFile } from "node:fs/promises";

type J2ProvisioningDiagnostic = {
  step: string;
  computerId: string;
  botId?: string;
  ms: number;
  [key: string]: unknown;
};

export async function writeJ2ProvisioningDiagnostic(
  diagnostic: J2ProvisioningDiagnostic,
): Promise<void> {
  if (process.env.RAKAZO_J2_DIAGNOSTICS !== "1") return;
  const file = process.env.RAKAZO_J2_DIAGNOSTICS_FILE;
  if (!file) return;
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...diagnostic })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  }).catch(() => undefined);
}
