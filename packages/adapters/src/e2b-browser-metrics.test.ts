import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { e2bBrowserMetricsCommands } from "./e2b-browser-metrics.js";

// Exercise the rendered guest command against real temporary files. Only kernel mount/proc
// operations are simulated; native mount and pause compatibility remain integration gates.
const FIXTURE = String.raw`import builtins, io, json, os, pathlib, subprocess, sys
from unittest.mock import patch
root, script, operation, profile_name, scenario = sys.argv[1:]
os.environ['SUDO_UID'] = str(os.geteuid())
os.environ['SUDO_GID'] = str(os.getegid())
P = pathlib.Path
profile = P(profile_name)
target = profile / 'BrowserMetrics'
state = P('/tmp/rakazo/browser-metrics')

def mapped(value):
    value = os.fspath(value)
    if isinstance(value, str) and (value == '/tmp' or value.startswith(('/workspace', '/tmp/rakazo', '/proc'))):
        return root + value
    return value

def wrap(function):
    return lambda value, *args, **kwargs: function(mapped(value), *args, **kwargs)

patches = [patch.object(module, name, wrap(getattr(module, name))) for module, name in [
    (builtins, 'open'), (io, 'open'), (os, 'stat'), (os, 'lstat'), (os, 'mkdir'),
    (os, 'listdir'), (os, 'scandir'), (os, 'unlink'), (os, 'readlink'), (os, 'rmdir')]]
if hasattr(P(), '_accessor'):
    accessor = P()._accessor
    patches += [patch.object(accessor, name, wrap(getattr(accessor, name))) for name in
        ('open', 'stat', 'lstat', 'mkdir', 'listdir', 'scandir', 'unlink', 'readlink', 'rmdir')]
original_symlink = os.symlink
symlink = lambda source, destination, *args, **kwargs: original_symlink(source, mapped(destination), *args, **kwargs)
patches.append(patch.object(os, 'symlink', symlink))
if hasattr(P(), '_accessor'): patches.append(patch.object(accessor, 'symlink', symlink))
for item in patches: item.start()
P('/proc/self').mkdir(parents=True)
P('/proc/meminfo').write_text('MemTotal:       1048576 kB\n')
if scenario == 'new-profile': profile.parents[1].mkdir(parents=True)
else: profile.mkdir(parents=True)
mountinfo = P('/proc/self/mountinfo')
base = '10 1 0:10 / /workspace/bots/bot rw - nfs server:/volume rw\n'
mountinfo.write_text(base)
commands = []

def kernel(argv, **kwargs):
    commands.append(argv[0])
    if argv[0] == 'mount':
        assert argv[:4] == ['mount', '-t', 'tmpfs', '-o']
        assert set(argv[4].split(',')) == {'size=64m', 'nr_inodes=1024', 'nosuid', 'nodev', 'noexec', 'mode=0700', 'uid=' + str(os.geteuid()), 'gid=' + str(os.getegid())}
        assert argv[5:] == ['rakazo-browser-metrics', str(target)]
        if scenario == 'mount-fails': raise RuntimeError('mount unsupported')
        mountinfo.write_text(base + '11 10 0:11 / ' + str(target) + ' rw,nosuid,nodev,noexec - tmpfs rakazo-browser-metrics rw,size=65536k,nr_inodes=1024\n')
    elif argv[0] == 'umount':
        assert argv == ['umount', '--', str(target)]
        if scenario == 'unmount-fails': raise RuntimeError('busy mount')
        mountinfo.write_text(base)
    else: raise AssertionError(argv)

sys.argv = ['metrics', operation, profile_name]
with patch.object(subprocess, 'run', kernel):
    def run():
        exec(compile(script, '<generated-metrics>', 'exec'), {})
    def attempt():
        try:
            run()
            return 'ok'
        except SystemExit as error:
            assert error.code == 0
            return 'ok'
        except RuntimeError as error:
            return str(error)
    if scenario == 'bad-path': sys.argv[2] = '/workspace/bots/../other'
    if scenario == 'symlink':
        target.symlink_to('/tmp')
    if scenario == 'active-missing':
        P('/proc/123').mkdir()
        P('/proc/123/cmdline').write_bytes(('--user-data-dir=' + profile_name + '\0').encode())
        P('/proc/123/maps').write_text('')
    if scenario == 'admission-full':
        state.mkdir(parents=True)
        (state / 'one.json').write_text('[]')
        (state / 'two.json').write_text('[]')
    if scenario == 'capacity':
        P('/proc/meminfo').write_text('MemTotal:       262144 kB\n')
    if scenario == 'unknown-mount':
        target.mkdir()
        mountinfo.write_text(base + '11 10 0:11 / ' + str(target) + ' rw - tmpfs other rw\n')
    if scenario in ('reuse-release', 'parent-remount', 'mapping-changed', 'unmount-fails', 'release-active', 'missing-mount', 'live-reuse'):
        assert attempt() == 'ok'
        if scenario == 'parent-remount': mountinfo.write_text(mountinfo.read_text().replace('10 1 ', '12 1 '))
        if scenario == 'mapping-changed':
            P('/proc/123').mkdir()
            P('/proc/123/cmdline').write_bytes(b'')
            P('/proc/123/maps').write_text('1000-2000 rw-s 0 ff:ff 123 ' + str(target) + '/old.pma (deleted)\n')
        if scenario == 'live-reuse':
            active = target / 'active.pma'
            active.write_bytes(b'active')
            device = active.stat().st_dev
            dev = '%02x:%02x' % (os.major(device), os.minor(device))
            P('/proc/123').mkdir()
            P('/proc/123/cmdline').write_bytes(('--user-data-dir=' + profile_name + '\0').encode())
            P('/proc/123/maps').write_text('1000-2000 rw-s 0 ' + dev + ' ' + str(active.stat().st_ino) + ' ' + str(active) + '\n')
        if scenario == 'missing-mount': mountinfo.write_text(base)
        if scenario == 'release-active':
            P('/proc/123').mkdir()
            P('/proc/123/cmdline').write_bytes(('--user-data-dir=' + profile_name + '\0').encode())
            P('/proc/123/maps').write_text('')
            sys.argv[1] = 'release'
        result = attempt()
        if scenario == 'live-reuse':
            assert result == 'ok'
            active.unlink()
            P('/proc/123/maps').write_text(P('/proc/123/maps').read_text().rstrip('\n') + ' (deleted)\n')
            result = attempt()
        if scenario in ('reuse-release', 'unmount-fails'):
            sys.argv[1] = 'release'
            result = attempt()
    else:
        result = attempt()
    print(json.dumps({'result': result, 'commands': commands, 'receipts': len(list(state.glob('*.json')))}))
`;

it.each([
  ["live-reuse", "ok", ["mount"], 1],
  ["admission-full", "browser metrics: metrics capacity exhausted", [], 2],
  ["new-profile", "ok", ["mount"], 1],
  ["reuse-release", "ok", ["mount", "umount"], 0],
  ["bad-path", "browser metrics: unexpected managed profile", [], 0],
  ["mount-fails", "mount unsupported", ["mount"], 0],
  ["release-active", "browser metrics: profile still has live owners", ["mount"], 1],
  ["missing-mount", "browser metrics: recorded metrics mount disappeared", ["mount"], 1],
  ["symlink", "browser metrics: symlink in managed path", [], 0],
  ["active-missing", "browser metrics: live profile lacks its metrics mount", [], 0],
  ["capacity", "browser metrics: metrics capacity exhausted", [], 0],
  ["unknown-mount", "browser metrics: unexpected metrics mount", [], 0],
  ["parent-remount", "browser metrics: metrics or durable profile identity changed", ["mount"], 1],
  ["mapping-changed", "browser metrics: live metrics mapping changed", ["mount"], 1],
  ["unmount-fails", "busy mount", ["mount", "umount"], 1],
])("runs the fixed metrics lifecycle for %s", (scenario, result, commands, receipts) => {
  const root = mkdtempSync(path.join(tmpdir(), "metrics-test-"));
  try {
    const fixture = path.join(root, "fixture.py");
    writeFileSync(fixture, FIXTURE);
    const profile = `/workspace/bots/bot/.browser-profiles/chromium-bot-${"a".repeat(32)}`;
    const command = e2bBrowserMetricsCommands(profile).ensure;
    const execution = spawnSync(
      "bash",
      ["-eu", "-c", `sudo() { shift 3; python3 "$FIXTURE" "$ROOT" "$@" "$SCENARIO"; }; ${command}`],
      {
        encoding: "utf8",
        env: { ...process.env, FIXTURE: fixture, ROOT: root, SCENARIO: scenario },
        timeout: 5000,
      },
    );
    expect(execution.status, execution.stderr).toBe(0);
    expect(JSON.parse(execution.stdout)).toEqual({ result, commands, receipts });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
