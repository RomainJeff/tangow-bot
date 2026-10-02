import { appendFile } from "node:fs/promises";

type ProvisioningDiagnostic = {
  step: string;
  computerId: string;
  botId?: string;
  ms: number;
  [key: string]: unknown;
};

export async function writeProvisioningDiagnostic(
  diagnostic: ProvisioningDiagnostic,
): Promise<void> {
  if (process.env.RAKAZO_PROVISIONING_DIAGNOSTICS !== "1") return;
  const file = process.env.RAKAZO_PROVISIONING_DIAGNOSTICS_FILE;
  if (!file) return;
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...diagnostic })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  }).catch(() => undefined);
}
