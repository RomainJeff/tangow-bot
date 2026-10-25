export function buildComputers({ provider, values, override, run, dock }) {
  console.log("Building computer image...");
  const image = provider === "e2b" ? values["computer-image"] : "rakazo/computer:local";
  const connection = { ...process.env };
  if (override) {
    const saved = override.services.api.environment;
    Object.assign(
      connection,
      Object.fromEntries(
        Object.entries(saved).filter(
          ([name]) => name.startsWith("E2B_") || name === "WORKER_TEMPLATE",
        ),
      ),
    );
    run("pnpm (install supported Node and enable Corepack first)", "pnpm", ["--version"]);
    console.log("Installing template build dependencies for the checkout revision...");
    run("Template dependencies", "pnpm", ["install", "--frozen-lockfile"], {
      env: {
        ...process.env,
        CI: "true",
        ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    });
  }
  dock("Computer image build", [
    "build",
    ...(provider === "e2b" ? ["--platform", "linux/amd64"] : []),
    "-t",
    image,
    "infra/sandboxes/computer",
  ]);
  if (override) {
    dock("Computer image push", ["push", image]);
    dock("Local computer image tag", ["tag", image, "rakazo/computer:local"]);
    const digest = dock("Computer image digest", [
      "image",
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      image,
    ]).stdout.trim();
    if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error("Registry did not return an immutable computer image digest.");
    console.log("Building E2B worker template...");
    run(
      "Worker template build",
      "pnpm",
      [
        "--filter",
        "@rakazo/agent-run-worker",
        "template:build",
        "--name",
        connection.WORKER_TEMPLATE || "rakazo-worker-pi-native",
      ],
      { env: connection },
    );
    console.log("Building E2B desktop template...");
    run(
      "Desktop template build",
      "pnpm",
      ["--filter", "@rakazo/computer-e2b-template", "template:build", "--image", digest],
      { env: connection },
    );
  }
  console.log(
    "Computer builds ready. Replace existing computers from Settings > Computer; busy computers are skipped.",
  );
}
