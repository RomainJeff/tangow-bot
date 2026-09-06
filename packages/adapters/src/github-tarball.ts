/**
 * Skills v2 phase 3: marketplaces are public GitHub repositories (design Q6). We pin a ref to
 * a commit sha through the REST API, then stream the codeload tarball into a directory with a
 * byte cap and no symlinks/hardlinks (design Q7). No git binary, no auth.
 */
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { extract as tarExtract } from "tar";

export type GithubRepo = { owner: string; repo: string };

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;
const USER_AGENT = "rakazo-skills";
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

export function parseGithubRepoUrl(input: string): GithubRepo {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Marketplace URL must be a valid https://github.com/<owner>/<repo> URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(
      "Only public GitHub repositories are supported (https://github.com/<owner>/<repo>).",
    );
  }
  const [owner, rawRepo, ...rest] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || rest.length > 0 || !SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new Error("Marketplace URL must look like https://github.com/<owner>/<repo>.");
  }
  return { owner, repo };
}

/** Pins a ref (branch, tag, sha, HEAD) to a full commit sha via the GitHub REST API. */
export async function resolveGithubCommit(
  input: GithubRepo & { ref: string },
  fetchImpl: typeof fetch,
): Promise<string> {
  if (!REF.test(input.ref) || input.ref.includes("..")) throw new Error("Invalid git ref.");
  const url = `https://api.github.com/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.ref)}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.github.sha", "user-agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub returned ${response.status} for ${input.owner}/${input.repo}@${input.ref}.`,
    );
  }
  const sha = (await response.text()).trim();
  if (!SHA.test(sha)) throw new Error("GitHub did not return a commit sha.");
  return sha;
}

/**
 * Streams `codeload.github.com/<o>/<r>/tar.gz/<commit>` into `destDir`, stripping the
 * `<repo>-<sha>/` top directory. Regular files and directories only: symlinks/hardlinks are
 * dropped, tar already refuses `..` and absolute paths. Aborts once `maxBytes` is exceeded.
 */
export async function downloadGithubTarball(
  input: GithubRepo & { commit: string },
  destDir: string,
  options: { fetch: typeof fetch; maxBytes?: number },
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_TARBALL_BYTES;
  const url = `https://codeload.github.com/${input.owner}/${input.repo}/tar.gz/${input.commit}`;
  const response = await options.fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub tarball download failed (${response.status}).`);
  }
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new Error(`Marketplace tarball too large (> ${maxBytes} bytes).`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    limit,
    tarExtract({
      cwd: destDir,
      strip: 1,
      preservePaths: false,
      // On extract the entry is always a ReadEntry; the Stats half of the union is for create.
      filter: (_path, entry) =>
        "type" in entry && (entry.type === "File" || entry.type === "Directory"),
    }),
  );
}
