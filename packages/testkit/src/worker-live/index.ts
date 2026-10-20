import { laneG } from "./lane-faults.js";
import { laneH } from "./lane-migration.js";
import { laneA, laneF, laneI } from "./lanes-files.js";
import { laneD, laneE } from "./lanes-tools.js";
import { laneB, laneC } from "./lanes-vms.js";
import type { Lane } from "./session.js";

export { benchLive } from "./bench.js";
export {
  type Lane,
  type Live,
  liveSession,
  memAvailableMiB,
  requireHeadroom,
} from "./session.js";

const pendingLanes: Lane[] = [
  {
    id: "e-anthropic",
    issue: "proxy Anthropic simulé",
    scenario: "An Anthropic-protocol model behind the relay",
    passWhen: "The relay streams an Anthropic-protocol model with the controller's key",
    pending:
      "The model emulator speaks only OpenAI chat completions, and only an openai_compatible connection takes a base URL; the relay authorization slice (S3) owns the connection side.",
  },
  {
    id: "e-refusals",
    issue: "refus connexion/modèle/endpoint interdits",
    scenario: "A guest model request for a connection, model or endpoint the run does not grant",
    passWhen: "The controller refuses it and the upstream is never called",
    pending: "Model relay authorization lands with S3.",
  },
  {
    id: "b-product-computer",
    issue: "visibilité computer dans les deux sens (computer produit)",
    scenario: "The same exchange with the product's E2B computer mounting the volumes",
    passWhen: "The product computer sees the guest's writes and the guest sees the computer's",
    pending: "The E2B computer's volume mounts land with S3.",
  },
  {
    id: "h-product-recreate",
    issue: "recréation computer (produit)",
    scenario: "Recreate the product's E2B computer of an adopted home",
    passWhen: "No snapshot restore writes over the volumes",
    pending: "The E2B computer's volume mounts and restore switch land with S3.",
  },
];

export const LANES: Lane[] = [
  laneA,
  laneB,
  laneC,
  laneD,
  laneE,
  laneF,
  laneG,
  laneH,
  laneI,
  ...pendingLanes,
];

/** A memory series after each run, and its growth over the first and the last ten runs. */
