import type { SandboxProvider } from "@rakazo/adapter-kit";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxEmulator } from "./e2b-emulator.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

export interface SandboxProviderOptions {
  supervisorUrl?: string;
  supervisorToken?: string;
  e2bApiKey?: string;
  dataDir?: string;
}

export function createSandboxProvider(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  switch (kind) {
    case "none":
    case "":
      return new NoneSandboxProvider();
    case "e2b":
      if (!opts.e2bApiKey?.trim()) {
        return new NoneSandboxProvider(
          "Computers unavailable: E2B_API_KEY is required for SANDBOX_PROVIDER=e2b.",
        );
      }
      return new E2BSandboxProvider(opts.e2bApiKey);
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "e2b-emulator":
      return new E2BSandboxEmulator();
    case "desktop":
      return new DesktopSandboxProvider({
        root: opts.dataDir,
      });
    case "fake":
      return new FakeSandboxProvider();
    default:
      throw new Error(
        `Unknown SANDBOX_PROVIDER "${kind}". Use none | docker | e2b | e2b-emulator | desktop | fake.`,
      );
  }
}
