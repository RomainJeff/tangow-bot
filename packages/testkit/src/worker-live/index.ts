import { laneG, laneGTimeout } from "./lane-faults.js";
import { laneH, laneHomeMoveFence, laneHProductRecreate } from "./lane-migration.js";
import { laneNativeApproval } from "./lane-native-approval.js";
import { laneSkills } from "./lane-skills.js";
import { laneA, laneF, laneI } from "./lanes-files.js";
import { laneD, laneE, laneEAnthropic, laneERefusals } from "./lanes-tools.js";
import { laneB, laneBProductComputer, laneC } from "./lanes-vms.js";
import type { Lane } from "./session.js";

export { benchLive } from "./bench.js";
export {
  type Lane,
  type Live,
  liveSession,
  memAvailableMiB,
  requireHeadroom,
} from "./session.js";

export const LANES: Lane[] = [
  laneA,
  laneB,
  laneBProductComputer,
  laneC,
  laneD,
  laneE,
  laneEAnthropic,
  laneERefusals,
  laneF,
  laneG,
  laneGTimeout,
  laneH,
  laneHProductRecreate,
  laneHomeMoveFence,
  laneI,
  laneSkills,
  laneNativeApproval,
];
