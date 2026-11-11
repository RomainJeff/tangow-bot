import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";

async function prompt(answers, label, fallback = "", hidden = false) {
  let settings;
  const restore = () => {
    if (settings) spawnSync("stty", [settings], { stdio: [0, "ignore", "ignore"] });
  };
  const interrupt = () => {
    restore();
    process.exit(130);
  };
  try {
    if (hidden && process.stdin.isTTY) {
      const state = spawnSync("stty", ["-g"], { encoding: "utf8", stdio: [0, "pipe", "pipe"] });
      if (state.status !== 0) throw new Error("Cannot hide secret input on this terminal.");
      settings = state.stdout.trim();
      if (spawnSync("stty", ["-echo"], { stdio: [0, "ignore", "ignore"] }).status !== 0)
        throw new Error("Cannot hide secret input on this terminal.");
    }
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    writeSync(
      1,
      `${label}${fallback ? (hidden ? " [Enter keeps saved value]" : ` [${fallback}]`) : ""}: `,
    );
    const { value, done } = await answers.next();
    if (done)
      throw new Error(
        "Setup cancelled: input ended. Run setup in a terminal or supply all answers on stdin.",
      );
    if (hidden && process.stdin.isTTY) writeSync(1, "\n");
    const answer = value || fallback;
    if (/[\r\n\0]/.test(answer)) throw new Error("Enter a single-line value.");
    return answer;
  } finally {
    restore();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

function readEnvironment(contents) {
  const env = parseEnv(contents);
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*")\s*$/);
    if (match) {
      try {
        env[match[1]] = JSON.parse(match[2]).replaceAll("$$", "$");
      } catch {
        // Existing dotenv values may use escapes outside JSON's syntax.
      }
    }
  }
  return env;
}

function originUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a web origin such as http://127.0.0.1:5173 or https://app.example.com.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (!loopback && url.protocol !== "https:")
  )
    throw new Error(
      "Use an HTTPS web origin without credentials, path or query; HTTP is allowed on loopback.",
    );
  return { origin: url.origin, hostname: url.hostname, loopback };
}

export async function configureSetup({ root, values, provider, run, dock, git, writePrivate }) {
  run("Git", "git", ["--version"]);
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (
    !((major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || major === 24 || major >= 26)
  )
    throw new Error("Setup requires Node 22.22.2+, 24.x or 26+.");
  dock("Docker access (start Docker or use --sudo)", ["info"]);
  dock("Docker Compose", ["compose", "version"]);
  if (git(["status", "--porcelain"]))
    throw new Error("Checkout has local changes. Commit or move them before setup.");
  const filename = path.join(root, ".env");
  const original = existsSync(filename) ? readFileSync(filename, "utf8") : "";
  const saved = readEnvironment(original);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Tangow runs outside Turbo and must match Compose project selection.
  const project = process.env.COMPOSE_PROJECT_NAME || saved.COMPOSE_PROJECT_NAME || "compose";
  const containers = dock("Existing deployment containers", [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]).stdout.trim();
  const volumes = dock("Existing deployment volumes", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]).stdout.trim();
  const data = path.join(root, "data");
  const deployed = Boolean(containers || volumes || (existsSync(data) && readdirSync(data).length));
  const secrets = [
    "POSTGRES_PASSWORD",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "SANDBOX_SUPERVISOR_TOKEN",
    "SCREEN_PROXY_SECRET",
  ];
  const missing = secrets.filter(
    (name) => !saved[name] || /^(?:replace-with-|REPLACE_)/.test(saved[name]),
  );
  if (deployed && missing.length)
    throw new Error(
      "Existing deployment has missing or placeholder credentials. Restore its original .env secrets before setup; setup never rotates them.",
    );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const answers = input[Symbol.asyncIterator]();
  try {
    console.log(
      `Setup deploys checkout ${git(["rev-parse", "HEAD"])} without fetching or switching branches.`,
    );
    const chosen = originUrl(
      await prompt(answers, "Web origin", saved.WEB_ORIGIN || "http://127.0.0.1:5173"),
    );
    const next = { ...saved };
    Object.assign(next, {
      NODE_ENV: "production",
      WEB_ORIGIN: chosen.origin,
      BETTER_AUTH_URL: chosen.origin,
      API_URL: chosen.loopback ? "http://127.0.0.1:3100" : chosen.origin,
      TANGOW_HOST: chosen.hostname,
    });
    if (!chosen.loopback) {
      console.log(
        "Configure your HTTPS reverse proxy to 127.0.0.1:5173 before continuing. Setup does not configure DNS or TLS.",
      );
      next.SMTP_URL = await prompt(answers, "SMTP URL", saved.SMTP_URL, true);
      try {
        const smtp = new URL(next.SMTP_URL);
        if (!["smtp:", "smtps:"].includes(smtp.protocol) || !smtp.hostname) throw new Error();
      } catch {
        throw new Error("Public setup requires an smtp:// or smtps:// SMTP URL.");
      }
      next.EMAIL_FROM = await prompt(answers, "Email sender", saved.EMAIL_FROM);
      next.SIGNUP_ALLOWLIST = await prompt(
        answers,
        "Signup allowlist (emails or @domain, comma-separated)",
        saved.SIGNUP_ALLOWLIST,
      );
      if (!next.EMAIL_FROM || !next.SIGNUP_ALLOWLIST)
        throw new Error(
          "Public setup requires an email sender and signup allowlist before first startup.",
        );
      const allowlist = next.SIGNUP_ALLOWLIST.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        !allowlist.length ||
        allowlist.some((value) => !/^(?:[^@\s]+)?@[a-zA-Z0-9.-]+$/.test(value))
      )
        throw new Error("Use email addresses or @example.com domains in the signup allowlist.");
      next.SIGNUPS_ENABLED = saved.SIGNUPS_ENABLED || "true";
      if (deployed) console.log("Setup applies this signup policy to existing accounts too.");
    }
    let selectedProvider = provider;
    if (provider !== "e2b") {
      console.log(
        "E2B starts with a Docker deployment, then uses the existing E2B setup. E2B infrastructure and registry access must already be available.",
      );
      selectedProvider = await prompt(answers, "Computer provider (docker/e2b)", "docker");
      if (!["docker", "e2b"].includes(selectedProvider)) throw new Error("Choose docker or e2b.");
    }
    if (selectedProvider === "e2b") {
      values["computer-image"] ||= await prompt(
        answers,
        "Pushable computer image (registry/repository:tag)",
      );
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_.-]+$/.test(values["computer-image"]) ||
        !values["computer-image"].includes("/")
      )
        throw new Error("Use a pushable registry/repository:tag for the E2B computer image.");
      run("pnpm (enable Corepack first)", "pnpm", ["--version"]);
    }
    if ((await prompt(answers, "Build and start this deployment? (yes/no)", "yes")) !== "yes")
      throw new Error("Setup cancelled. No configuration was written.");
    for (const name of missing) next[name] = randomBytes(32).toString("hex");
    next.POSTGRES_USER ||= "rakazo";
    next.POSTGRES_DB ||= "rakazo";
    next.SANDBOX_PROVIDER = provider;
    if (!saved.DATABASE_URL || saved.DATABASE_URL.includes("REPLACE_WITH_POSTGRES_PASSWORD"))
      next.DATABASE_URL = `postgres://${next.POSTGRES_USER}:${next.POSTGRES_PASSWORD}@127.0.0.1:5433/${next.POSTGRES_DB}`;
    const additions = Object.entries(next).filter(([name, value]) => saved[name] !== value);
    const contents = `${original}${original && !original.endsWith("\n") ? "\n" : ""}${additions.map(([name, value]) => `${name}=${JSON.stringify(value).replaceAll("$", () => "$$")}`).join("\n")}\n`;
    writePrivate(filename, contents);
    console.log("Private deployment configuration saved.");
    return { selectedProvider, origin: chosen.origin, loopback: chosen.loopback, deployed };
  } finally {
    input.close();
  }
}
