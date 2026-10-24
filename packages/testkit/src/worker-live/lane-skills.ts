import { buildSkillMd } from "@rakazo/core";
import { toolResult } from "../file-task.js";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { call, finish, liveRun, toolNames } from "./run.js";
import type { Lane } from "./session.js";

const prompt = (request: ModelEmulatorRequest) =>
  String(request.messages.find((message) => message.role === "system")?.content);

export const laneSkills: Lane = {
  id: "skills",
  issue: "skills on volumes",
  scenario:
    "Managed, bot and shared skills load through Pi; a native read and a skill script run; a bot-created skill is available on the next run",
  passWhen:
    "Both runs complete, all three sources are in the Pi catalog without skill_read, the script prints its marker, native usage and the new skill reach the controller, and the next run loads that skill",
  async run(live) {
    const observed = {
      managed: false,
      bot: false,
      shared: false,
      nativeOnly: false,
      script: false,
      nextRun: false,
    };
    const created = buildSkillMd({
      name: "created-live",
      description: "Use the procedure created on the first run",
      body: "Repeat the checked procedure.",
    });
    const worker = await liveRun(live, {
      computer: "team",
      steps: [
        call("read", "read", { path: "skills/bot-live/SKILL.md" }, (request) => {
          const text = prompt(request);
          observed.managed = text.includes("<name>Interrogate</name>");
          observed.bot = text.includes("<name>bot-live</name>");
          observed.shared = text.includes("<name>shared-live</name>");
          observed.nativeOnly =
            text.includes("<available_skills>") && !toolNames(request).includes("skill_read");
        }),
        call("script", "bash", { command: "bash skills/bot-live/scripts/run.sh" }),
        call(
          "create",
          "write",
          { path: "skills/created-live/SKILL.md", content: created },
          (request) => {
            observed.script = toolResult(request).includes("live skill script ran");
          },
        ),
        ...finish("Used skills and created a procedure"),
        call("next", "read", { path: "skills/created-live/SKILL.md" }, (request) => {
          observed.nextRun = prompt(request).includes("<name>created-live</name>");
        }),
        ...finish("Loaded the created procedure"),
      ],
    });
    let computer: Awaited<ReturnType<typeof live.vm>> | undefined;
    try {
      computer = await live.vm(worker.mounts());
      await computer.commands.run(
        `mkdir -p ${worker.privateMount}/skills/bot-live/scripts ${worker.sharedMount}/skills/shared-live`,
      );
      await computer.files.write(
        `${worker.privateMount}/skills/bot-live/SKILL.md`,
        buildSkillMd({
          name: "bot-live",
          description: "Run the bot's procedure",
          body: "Run scripts/run.sh with bash.",
        }),
      );
      await computer.files.write(
        `${worker.privateMount}/skills/bot-live/scripts/run.sh`,
        "echo 'live skill script ran'\n",
      );
      await computer.files.write(
        `${worker.sharedMount}/skills/shared-live/SKILL.md`,
        buildSkillMd({
          name: "shared-live",
          description: "Use the shared procedure",
          body: "Follow the shared procedure.",
        }),
      );
      const first = await worker.send("Follow bot-live and save a new skill.");
      const second = await worker.send("Read created-live.");
      await worker.completed(second);
      const index = await worker.run.prisma.volumeSkill.findMany({
        where: { botId: worker.run.bot.id },
      });
      const uses = await worker.run.prisma.event.count({
        where: { runId: first, type: "agent.skill.used" },
      });
      const indexed = index.some(
        (skill) => skill.name === "created-live" && skill.source === "bot",
      );
      return {
        pass:
          Object.values(observed).every(Boolean) &&
          indexed &&
          uses > 0 &&
          (await worker.status(first)) === "completed",
        observed: { ...observed, indexed, nativeUses: uses },
      };
    } finally {
      try {
        await computer?.kill();
      } finally {
        await worker.close();
      }
    }
  },
};
