import { Template } from "e2b";

// Preparation artifact only. There is deliberately no Template.build or image publication call.
export function computerTemplateFromCanonicalImage(imageDigest, repositoryRoot) {
  if (!/@sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error("Use the immutable digest of the canonical amd64 computer image");
  }
  return Template({ fileContextPath: repositoryRoot })
    .fromImage(imageDigest)
    .runCmd(
      'set -eu; groupmod -n user rakazo; usermod -l user -d /home/user -m rakazo; test "$(id -u user)" = 1000; mkdir -p /home/user/.cache; chown user:user /home/user/.cache; mkdir -p /workspace',
      { user: "root" },
    )
    .copy("skills/agent", "/managed-skills/agent", { user: "root" })
    .copy("skills/computer", "/managed-skills/computer", { user: "root" })
    .runCmd("chown -R root:root /managed-skills && chmod -R a-w /managed-skills", { user: "root" })
    .setEnvs({ HOME: "/home/user", DISPLAY: ":1", OPENCODE_DISABLE_AUTOUPDATE: "1" })
    .setUser("user")
    .setWorkdir("/home/user")
    .setStartCmd(
      "/usr/local/bin/rakazo-computer",
      "until DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null; do sleep 0.2; done",
    );
}
