import type { AdapterContext, ComputerRef } from "@tangow/adapter-kit";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** E2B protocol emulator backed by deterministic local state. */
export class E2BSandboxEmulator extends FakeSandboxProvider {
  override describe() {
    return { ...super.describe(), id: "e2b-emulator" };
  }
  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    return { ...(await super.provision(request, context)), kind: "e2b" };
  }
}
