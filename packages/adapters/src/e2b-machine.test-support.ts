import type { Sandbox } from "@e2b/desktop";

const WORKSPACE = "/home/user/rakazo-home";

/** An E2B computer as the SDK serves it: its workspace files by path, its metadata, its end. */
export function fakeE2BMachine(
  sandboxId: string,
  workspace: Record<string, string> = {},
  metadata: Record<string, string> = {},
) {
  const files = new Map(
    Object.entries(workspace).map(([file, text]) => [`${WORKSPACE}/${file}`, text]),
  );
  const machine = {
    files,
    killed: false,
    sandbox: {
      sandboxId,
      getInfo: async () => ({ metadata }),
      kill: async () => {
        machine.killed = true;
        return true;
      },
      setTimeout: async () => undefined,
      commands: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
      files: {
        list: async (directory: string) => {
          const names = new Map<string, "file" | "dir">();
          for (const file of files.keys()) {
            if (!file.startsWith(`${directory}/`)) continue;
            const [name, ...rest] = file.slice(directory.length + 1).split("/");
            names.set(name!, rest.length ? "dir" : "file");
          }
          return [...names].map(([name, type]) => ({ name, type, size: 1, mode: 0o644 }));
        },
        read: async (file: string) => {
          const text = files.get(file);
          if (text === undefined) throw new Error(`${file} not found`);
          return new TextEncoder().encode(text);
        },
        write: async (written: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of written) files.set(entry.path, new TextDecoder().decode(entry.data));
        },
        makeDir: async () => true,
      },
    } as unknown as Sandbox,
  };
  return machine;
}
