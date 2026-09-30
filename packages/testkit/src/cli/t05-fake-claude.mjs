import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sessionId = "t05-fake-session";
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) throw new Error("T05 fake Claude requires CLAUDE_CONFIG_DIR");

const resumeAt = process.argv.indexOf("--resume");
const resumedSession = resumeAt === -1 ? undefined : process.argv[resumeAt + 1];
if (resumeAt !== -1 && !resumedSession) throw new Error("--resume requires a session id");

await mkdir(configDir, { recursive: true, mode: 0o700 });
const sessionFile = path.join(configDir, "t05-session.json");
if (resumedSession) {
  const stored = JSON.parse(await readFile(sessionFile, "utf8"));
  if (stored.session_id !== resumedSession) throw new Error("T05 fake Claude session mismatch");
} else {
  await writeFile(sessionFile, `${JSON.stringify({ session_id: sessionId })}\n`, { mode: 0o600 });
}

for await (const _line of process.stdin) {
  process.stdout.write(
    `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "T05 replay" }] } })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed" })}\n`,
  );
  break;
}
