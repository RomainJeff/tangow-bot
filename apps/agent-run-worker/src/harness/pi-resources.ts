import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  formatSkillsForPrompt,
  loadSkills,
} from "@earendil-works/pi-coding-agent";

/** No settings, extensions, context files, templates or default search paths are read. */
export function piResources(cwd: string, skillsDir: string, instructions: string): ResourceLoader {
  let loaded = loadSkills({
    cwd,
    agentDir: skillsDir,
    skillPaths: [skillsDir],
    includeDefaults: false,
  });
  return {
    getSkills: () => loaded,
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
      throw new Error("Worker resources are fixed for this run");
    },
    reload: async () => {
      loaded = loadSkills({
        cwd,
        agentDir: skillsDir,
        skillPaths: [skillsDir],
        includeDefaults: false,
      });
    },
  };
}

export function piSkillInstructions(loader: ResourceLoader): string {
  return [loader.getSystemPrompt(), formatSkillsForPrompt(loader.getSkills().skills, "read")]
    .filter(Boolean)
    .join("\n\n");
}
