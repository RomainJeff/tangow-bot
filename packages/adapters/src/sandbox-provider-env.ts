/** Resolves the computer provider, refusing configurations that cannot run computers. */
export function resolveSandboxProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.SANDBOX_PROVIDER;
  if (configured !== undefined && !configured.trim()) {
    throw new Error("SANDBOX_PROVIDER is empty. Set it to docker or e2b, or remove it for docker.");
  }
  const requested = configured?.trim() || "docker";
  if (requested === "daytona" || requested === "box" || requested === "none") {
    throw new Error(
      `The ${requested} computer provider was removed. Set SANDBOX_PROVIDER to docker or e2b.`,
    );
  }
  if (requested === "e2b" && !optional(source.E2B_API_KEY)) {
    throw new Error("SANDBOX_PROVIDER=e2b needs E2B_API_KEY.");
  }
  if (
    requested === "docker" &&
    source.NODE_ENV === "production" &&
    !optional(source.SANDBOX_SUPERVISOR_TOKEN)
  ) {
    throw new Error("SANDBOX_PROVIDER=docker needs SANDBOX_SUPERVISOR_TOKEN in production.");
  }
  return requested;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
