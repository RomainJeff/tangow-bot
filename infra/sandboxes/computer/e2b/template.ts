import path from "node:path";
import type { TemplateBuilder } from "e2b";
import { Template } from "e2b";

/** The computer VM's profile, as validated in N13. */
export const COMPUTER_PROFILE = { cpuCount: 2, memoryMB: 4096 } as const;

/**
 * E2B's sandbox user is `user` with its own uid; the canonical image runs as `rakazo` 1000:1000.
 * This gives `user` uid/gid 1000 and moves the image's home to /home/user, keeping file ownership.
 */
const RECONCILE_ACCOUNT = String.raw`set -eu
python3 - <<'PY_ACCOUNT'
import grp, os, pathlib, pwd, stat, subprocess, tempfile

def require(ok, message):
    if not ok:
        raise SystemExit("E2B canonical account reconciliation: " + message)

canonical, provider = pwd.getpwnam("rakazo"), pwd.getpwnam("user")
old, new = pathlib.Path("/home/rakazo"), pathlib.Path("/home/user")
require(os.getuid() == 0, "requires build root before volumes mount")
require((canonical.pw_uid, canonical.pw_gid, canonical.pw_dir) == (1000, 1000, str(old)),
        "unexpected canonical identity")
require(provider.pw_uid != 1000 and provider.pw_gid != 1000 and provider.pw_dir == str(new),
        "unexpected provider identity")
for account in pwd.getpwall():
    require(account.pw_name in ("rakazo", "user") or
            (account.pw_uid not in (1000, provider.pw_uid) and
             account.pw_gid not in (1000, provider.pw_gid) and account.pw_dir not in (str(old), str(new))),
            "shared account identity or home")
require(grp.getgrnam("rakazo").gr_gid == 1000 and
        grp.getgrnam("user").gr_gid == provider.pw_gid and
        all(g.gr_name in ("rakazo", "user") or g.gr_gid not in (1000, provider.pw_gid)
            for g in grp.getgrall()) and not grp.getgrnam("rakazo").gr_mem,
        "shared primary group identity")
for home in (pathlib.Path("/home"), old, new):
    require(stat.S_ISDIR(home.lstat().st_mode), "home must be a real directory")
for line in pathlib.Path("/proc/self/mountinfo").read_text().splitlines():
    mount = line.split()[4]
    require(mount != "/home" and not mount.startswith("/home/"), "home must be unmounted image content")
cache = new / ".cache"
require(not cache.is_symlink() and (not cache.exists() or cache.is_dir()), "cache must be a real directory")
require(not (old / ".cache").is_symlink() and
        (not (old / ".cache").exists() or (old / ".cache").is_dir()), "canonical cache must be a real directory")
for command in (("userdel", "rakazo"), ("groupmod", "--gid", "1000", "user"),
                ("usermod", "--uid", "1000", "--gid", "1000", "user")):
    subprocess.run(command, check=True)
backup = None

def merge(source, target):
    global backup
    for entry in source.iterdir():
        dest = target / entry.name
        if not os.path.lexists(dest):
            entry.rename(dest)
        elif entry.is_dir() and not entry.is_symlink() and dest.is_dir() and not dest.is_symlink():
            merge(entry, dest)
        else:
            if backup is None:
                backup = pathlib.Path(tempfile.mkdtemp(prefix=".canonical-home-", dir=new))
            saved = backup / entry.relative_to(old)
            saved.parent.mkdir(parents=True, exist_ok=True)
            entry.rename(saved)
    source.rmdir()

merge(old, new)
cache.mkdir(exist_ok=True)
os.chown(cache, 1000, 1000, follow_symlinks=False)
if backup is not None:
    os.chown(backup, 1000, 1000)
    print("Preserved conflicting canonical home entries in " + str(backup))
PY_ACCOUNT
mkdir -p /workspace`;

/** Repository root, the build context for the managed skills. */
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");

/**
 * The canonical computer image (../Dockerfile), adapted to E2B. The SDK cannot build a
 * multi-stage Dockerfile, so the image is built with Docker and referenced by digest.
 */
export function computerTemplate(imageDigest: string): ReturnType<TemplateBuilder["setStartCmd"]> {
  if (!/@sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error("Use the immutable digest of the canonical amd64 computer image");
  }
  return Template({ fileContextPath: REPOSITORY_ROOT })
    .fromImage(imageDigest)
    .runCmd(RECONCILE_ACCOUNT, { user: "root" })
    .copy("skills/agent", "/managed-skills/agent", { user: "root" })
    .copy("skills/computer", "/managed-skills/computer", { user: "root" })
    .runCmd("chown -R root:root /managed-skills && chmod -R a+rX,a-w /managed-skills", {
      user: "root",
    })
    .setEnvs({ HOME: "/home/user", DISPLAY: ":1", OPENCODE_DISABLE_AUTOUPDATE: "1" })
    .setUser("user")
    .setWorkdir("/home/user")
    .setStartCmd(
      "/usr/local/bin/rakazo-computer",
      "until DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null; do sleep 0.2; done",
    );
}
