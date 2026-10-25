import type { SandboxProvider } from "@rakazo/adapter-kit";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxEmulator } from "./e2b-emulator.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

export interface SandboxProviderOptions {
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
}

export function createSandboxProvider(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  switch (kind) {
    case "e2b":
      if (!opts.e2bApiKey?.trim()) {
        throw new Error("SANDBOX_PROVIDER=e2b needs E2B_API_KEY.");
      }
      return new E2BSandboxProvider(opts.e2bApiKey);
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "e2b-emulator":
      return new E2BSandboxEmulator();
    case "fake":
      return new FakeSandboxProvider();
    default:
      throw new Error(
        `Unknown SANDBOX_PROVIDER "${kind}". Use docker | e2b | e2b-emulator | fake.`,
      );
  }
}
