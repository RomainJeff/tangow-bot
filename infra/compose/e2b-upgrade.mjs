import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function acquireSetupLock(root) {
  const filename = path.join(root, ".env.e2b.setup.lock");
  if (existsSync(filename)) {
    const pid = Number(readFileSync(filename, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error("Invalid setup lock; inspect it before retrying");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
      else throw error;
    }
    if (alive) throw new Error("Another E2B setup process is running");
    rmSync(filename);
  }
  writeFileSync(filename, String(process.pid), { flag: "wx", mode: 0o600 });
  process.once("exit", () => {
    if (existsSync(filename) && readFileSync(filename, "utf8") === String(process.pid))
      rmSync(filename);
  });
}

/** The journal is also the rollback boundary: after preparation starts the old provider cannot safely resume. */
export class HomeUpgrade {
  constructor({ root, compose, env, run, prompt, flags, template }) {
    Object.assign(this, { root, compose, env, run, prompt, flags, template });
    this.journalPath = path.join(root, ".env.e2b.upgrade.json");
    this.state = existsSync(this.journalPath)
      ? JSON.parse(readFileSync(this.journalPath, "utf8"))
      : null;
  }

  get active() {
    return this.state !== null;
  }

  oneoff(script, args = [], report) {
    const command = [
      ...this.compose,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      ...Object.keys(this.env)
        .filter((name) => name.startsWith("E2B_"))
        .flatMap((name) => ["-e", name]),
      "-e",
      "WORKER_TEMPLATE",
      "api",
      "pnpm",
      "exec",
      "tsx",
      script,
      ...args,
    ];
    const result = spawnSync("docker", command, {
      cwd: this.root,
      env: { ...this.env, WORKER_TEMPLATE: this.template },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (report) {
      let output = result.stdout + result.stderr;
      for (const [key, value] of Object.entries(this.env))
        if (/key|token|secret|password/i.test(key) && value)
          output = output.replaceAll(value, "[redacted]");
      writeFileSync(report, output, { mode: 0o600 });
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `Home upgrade command failed (${script}). Services remain stopped when an upgrade journal exists.`,
      );
    }
    if (result.error || (result.status !== 0 && parsed.outcome !== "refused"))
      throw new Error(`Home upgrade command failed (${script}).`);
    return parsed;
  }

  inspect(plans = false) {
    this.inventory = this.oneoff("scripts/setup-e2b-homes.ts", [
      "--inspect",
      ...(plans ? ["--plans"] : []),
    ]);
    if (!Array.isArray(this.inventory.computers) || !this.inventory.blockers)
      throw new Error("Invalid home upgrade inventory");
    if (Object.values(this.inventory.blockers).some((value) => value !== 0))
      throw new Error(
        "Active generations, computer control, leases, maintenance or unsupported providers prevent setup. Finish or cancel work before retrying.",
      );
    if (plans && this.inventory.previews?.length) {
      this.planPath = path.join(this.root, ".env.e2b.plan.json");
      writeFileSync(this.planPath, `${JSON.stringify(this.inventory.previews, null, 2)}\n`, {
        mode: 0o600,
      });
      chmodSync(this.planPath, 0o600);
    }
    return this.inventory.computers.length;
  }

  confirm() {
    if (!this.inventory.computers.length || this.active) return;
    if (
      !this.flags["migrate-existing"] &&
      this.prompt(
        `Migrate ${this.inventory.computers.length} existing computer home(s) to E2B volumes? This is one way; originals and backups are retained. Type yes`,
        "no",
      ) !== "yes"
    ) {
      throw new Error(
        "Existing homes require migration. No templates or deployment settings changed. Use --migrate-existing for noninteractive consent.",
      );
    }
    const unmapped = (this.inventory.previews ?? []).reduce(
      (total, preview) => total + preview.notCopied.length,
      0,
    );
    this.leaveUnmapped = Boolean(this.flags["leave-unmapped"]);
    if (unmapped && !this.leaveUnmapped) {
      console.log(`Private migration report: ${this.planPath}`);
      this.leaveUnmapped =
        this.prompt(
          `${unmapped} legacy entries cannot map to bot/shared volumes. Keep them only in original homes and backups? Type yes`,
          "no",
        ) === "yes";
      if (!this.leaveUnmapped)
        throw new Error(
          "Unmapped legacy entries require consent before setup. No service was stopped. Review the private report, then retry with --leave-unmapped if acceptable.",
        );
    }
  }

  persist() {
    const temporary = `${this.journalPath}.tmp-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.journalPath);
  }

  backupDatabase() {
    const file = openSync(path.join(this.state.backup, "database.dump"), "w", 0o600);
    let result;
    try {
      result = spawnSync(
        "docker",
        [
          ...this.compose,
          "exec",
          "-T",
          "postgres",
          "sh",
          "-c",
          'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
        ],
        { cwd: this.root, stdio: ["ignore", file, "pipe"] },
      );
    } finally {
      closeSync(file);
    }
    if (result.error || result.status !== 0)
      throw new Error("Database backup failed; upgrade did not start.");
    const input = openSync(path.join(this.state.backup, "database.dump"), "r");
    try {
      result = spawnSync(
        "docker",
        [...this.compose, "exec", "-T", "postgres", "pg_restore", "--list"],
        { cwd: this.root, stdio: [input, "ignore", "pipe"] },
      );
    } finally {
      closeSync(input);
    }
    if (result.error || result.status !== 0)
      throw new Error("Database backup verification failed.");
    this.state.databaseSaved = true;
    this.persist();
  }

  perform() {
    const needed = this.active || this.inventory.computers.length > 0;
    console.log("Stopping application services for safe worker verification and home upgrades...");
    this.run("docker", [...this.compose, "stop", "api", "worker"]);
    this.inspect();
    if (!needed && !this.inventory.computers.length) return;
    if (!this.active) {
      const backup = path.join(this.root, "backups", `e2b-${randomUUID()}`);
      mkdirSync(backup, { recursive: true, mode: 0o700 });
      this.state = {
        backup,
        computers: this.inventory.computers,
        databaseSaved: false,
        dataSaved: false,
        leaveUnmapped: this.leaveUnmapped || Boolean(this.flags["leave-unmapped"]),
      };
      writeFileSync(this.journalPath, `${JSON.stringify(this.state)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    }
    if (!this.state.databaseSaved) this.backupDatabase();
    console.log("Checkpointing and stopping source computers...");
    for (const computer of this.inventory.computers)
      this.oneoff("scripts/setup-e2b-homes.ts", ["--prepare", computer.id]);
    if (!this.state.dataSaved) {
      console.log("Backing up persistent application data...");
      const archive = path.join(this.state.backup, "data.tar.gz");
      this.run("tar", ["-czf", `${archive}.tmp`, "data"]);
      chmodSync(`${archive}.tmp`, 0o600);
      renameSync(`${archive}.tmp`, archive);
      this.state.dataSaved = true;
      this.persist();
    }
    console.log("Migrating existing homes to volumes, team homes first...");
    for (const computer of this.inventory.computers) {
      const name = encodeURIComponent(computer.id);
      const reportPath = path.join(this.state.backup, `${name}-plan.json`);
      const args = ["--computer", computer.id, "--template", this.template];
      let plan = this.oneoff(
        "scripts/migrate-home-to-volumes.ts",
        [...args, "--dry-run", ...(this.state.leaveUnmapped ? ["--leave-unmapped"] : [])],
        reportPath,
      );
      if (
        plan.outcome === "refused" &&
        plan.refusal?.code === "not_copied" &&
        !this.state.leaveUnmapped
      ) {
        const count = plan.refusal.entries?.length ?? 0;
        console.log(`Migration report saved in ${reportPath}`);
        if (
          !this.flags["leave-unmapped"] &&
          this.prompt(
            `${count} legacy entries cannot map to bot/shared volumes. Keep them only in the original home and backup? Type yes`,
            "no",
          ) !== "yes"
        ) {
          throw new Error(
            "Unmapped legacy entries need explicit consent. Review the private report, then retry with --leave-unmapped if acceptable.",
          );
        }
        this.state.leaveUnmapped = true;
        this.persist();
        plan = this.oneoff(
          "scripts/migrate-home-to-volumes.ts",
          [...args, "--dry-run", "--leave-unmapped"],
          reportPath,
        );
      }
      if (plan.outcome === "already_on_volumes") continue;
      if (plan.outcome !== "planned")
        throw new Error(
          `Home migration refused: ${plan.refusal?.code ?? "invalid plan"}. See ${reportPath}`,
        );
      const manifest = `/data/e2b-upgrade/${name}-${randomUUID()}.json`;
      const result = this.oneoff(
        "scripts/migrate-home-to-volumes.ts",
        [
          ...args,
          "--manifest",
          manifest,
          ...(this.state.leaveUnmapped ? ["--leave-unmapped"] : []),
        ],
        path.join(this.state.backup, `${name}-result.json`),
      );
      if (result.outcome !== "adopted" && result.outcome !== "already_on_volumes")
        throw new Error(
          `Home migration did not complete: ${result.refusal?.code ?? result.outcome}`,
        );
    }
    for (const spaceId of new Set(
      this.state.computers.filter((c) => c.scope === "team").map((c) => c.spaceId),
    )) {
      const report = this.oneoff(
        "scripts/migrate-skills-to-volumes.ts",
        ["--space", spaceId, "--template", this.template],
        path.join(this.state.backup, `${encodeURIComponent(spaceId)}-skills.json`),
      );
      if (report.events?.some((event) => event.kind === "conflict"))
        throw new Error(
          "Legacy skill conflicts need resolution; the private report is in the upgrade backup.",
        );
    }
  }

  verify() {
    this.oneoff("scripts/setup-e2b-homes.ts", ["--verify"]);
  }

  complete() {
    if (!this.active) return;
    console.log(
      `Existing homes upgraded. Original snapshots retained; backup: ${this.state.backup}`,
    );
    rmSync(this.journalPath);
    this.state = null;
  }
}
