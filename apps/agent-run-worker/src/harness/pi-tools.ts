import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { ConnectorTool } from "@rakazo/adapter-kit";

/** Pi's own tools, as the SDK-free manifest the controller reads. */
export function piToolManifest(): ConnectorTool[] {
  const cwd = "/workspace";
  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ].map(({ name, description, parameters }) => ({
    name,
    description,
    inputSchema: JSON.parse(JSON.stringify(parameters)),
    readOnly: !["write", "edit", "bash"].includes(name),
  }));
}
