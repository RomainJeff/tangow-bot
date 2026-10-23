import type { DesktopProfileCommands } from "@rakazo/core/node/desktop-runtime";
import { shellQuote } from "@rakazo/core/node/desktop-runtime";

// This guest already trusts its user with root authority. These checks reject incompatible
// managed state; they do not confine a hostile writer racing changes to guest paths.
const METRICS = String.raw`import fcntl, json, os, pathlib, re, subprocess, sys, time

def refuse(message):
    raise RuntimeError('browser metrics: ' + message)

operation, name = sys.argv[1:]
profile = pathlib.Path(name)
if re.fullmatch(r'/home/user/rakazo-home/\.browser-profiles/chromium-bot-[a-f0-9]{32}', name):
    sys.exit(0)
if not re.fullmatch(r'/workspace/bots/[A-Za-z0-9_-]{1,64}/\.browser-profiles/chromium-bot-[a-f0-9]{32}', name):
    refuse('unexpected managed profile')
if operation not in ('ensure', 'release'):
    refuse('unexpected operation')

state = pathlib.Path('/tmp/rakazo/browser-metrics')
state.mkdir(parents=True, exist_ok=True)
with (state / '.lock').open('a') as lock:
    deadline = time.monotonic() + 10
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline: refuse('metrics admission lock timed out')
            time.sleep(0.05)
    target = profile / 'BrowserMetrics'
    receipt = state / (profile.name.removeprefix('chromium-bot-') + '.json')
    for directory in reversed([target, *target.parents]):
        if directory.is_symlink(): refuse('symlink in managed path')
        if directory.exists() and not directory.is_dir(): refuse('non-directory in managed path')
    mounts = []
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ')
        fields, fs = left.split(), right.split()
        mounts.append((fields, fs))
    backing = [(fields, fs) for fields, fs in mounts if name == fields[4] or name.startswith(fields[4].rstrip('/') + '/')]
    parent_mount, parent_fs = max(backing, key=lambda mount: len(mount[0][4]))
    if parent_mount[4] != str(profile.parents[1]) or parent_fs[0] not in ('nfs', 'nfs4'):
        refuse('unexpected durable profile mount')
    exact = [(fields, fs) for fields, fs in mounts if fields[4] == str(target)]
    if len(exact) > 1: refuse('stacked metrics mounts')
    if any(fields[4].startswith(str(target) + '/') for fields, _ in mounts):
        refuse('nested metrics mount')

    owners, mappings = [], []
    for process in pathlib.Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
            for arg in args:
                if arg.startswith(b'--user-data-dir='):
                    candidate = os.fsdecode(arg.split(b'=', 1)[1])
                    if candidate == name or (profile.exists() and os.path.exists(candidate) and os.path.samefile(candidate, profile)):
                        owners.append(process.name)
            for line in (process / 'maps').read_text().splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6 and fields[5].startswith(str(target) + '/'):
                    mappings.append((fields[3], int(fields[4])))
        except (FileNotFoundError, ProcessLookupError):
            continue
    if operation == 'release' and (owners or mappings):
        refuse('profile still has live owners')

    def identity():
        parent_stat, target_stat = profile.stat(), target.stat()
        return [parent_stat.st_dev, parent_stat.st_ino, target_stat.st_dev, target_stat.st_ino, exact[0][0][0], parent_mount[0]]

    saved = json.loads(receipt.read_text()) if receipt.exists() else None
    if exact:
        fields, fs = exact[0]
        options = set(fields[5].split(',')) | set(fs[2].split(','))
        if fs[:2] != ['tmpfs', 'rakazo-browser-metrics'] or not {'nosuid', 'nodev', 'noexec', 'size=65536k', 'nr_inodes=1024'} <= options:
            refuse('unexpected metrics mount')
        if saved != identity(): refuse('metrics or durable profile identity changed')
        device = target.stat().st_dev
        expected_device = '%02x:%02x' % (os.major(device), os.minor(device))
        inodes = {entry.stat().st_ino for entry in target.iterdir() if entry.is_file()}
        if any(dev != expected_device or inode not in inodes for dev, inode in mappings):
            refuse('live metrics mapping changed')
        if operation == 'ensure': sys.exit(0)
        subprocess.run(['umount', '--', str(target)], check=True, timeout=10)
        receipt.unlink()
        sys.exit(0)
    if owners or mappings: refuse('live profile lacks its metrics mount')
    if saved is not None: refuse('recorded metrics mount disappeared')
    if operation == 'release': sys.exit(0)

    # Reserve at most one eighth of RAM, and at most sixteen 64 MiB mounts. This
    # bounds admitted tmpfs capacity, not Chrome telemetry growth or its adequacy.
    memory_kib = int(re.search(r'^MemTotal:\s+(\d+) kB$', pathlib.Path('/proc/meminfo').read_text(), re.M)[1])
    limit = min(16, memory_kib // (8 * 65536))
    admitted = max(len(list(state.glob('*.json'))), sum(fs[:2] == ['tmpfs', 'rakazo-browser-metrics'] for _, fs in mounts))
    if admitted >= limit: refuse('metrics capacity exhausted')
    # Create durable directories as the browser user, never as the privileged mounter.
    uid, gid = int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID'])
    previous_uid, previous_gid = os.geteuid(), os.getegid()
    try:
        os.setegid(gid)
        os.seteuid(uid)
        profile.mkdir(parents=True, exist_ok=True)
        target.mkdir(exist_ok=True)
    finally:
        os.seteuid(previous_uid)
        os.setegid(previous_gid)
    owner = profile.stat()
    subprocess.run(['mount', '-t', 'tmpfs', '-o', 'size=64m,nr_inodes=1024,nosuid,nodev,noexec,mode=0700,uid=%d,gid=%d' % (owner.st_uid, owner.st_gid), 'rakazo-browser-metrics', str(target)], check=True, timeout=10)
    # Read the kernel's mount ID after mounting. Never reuse a mount merely by path.
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ')
        if left.split()[4] == str(target): exact.append((left.split(), right.split()))
    if len(exact) != 1: refuse('metrics mount not visible')
    receipt.write_text(json.dumps(identity()))
`;

export const e2bBrowserMetricsCommands: DesktopProfileCommands = (profile) => {
  const command = (operation: "ensure" | "release") =>
    `sudo -n python3 -c ${shellQuote(METRICS)} ${operation} ${shellQuote(profile)}`;
  return { ensure: command("ensure"), release: command("release") };
};
