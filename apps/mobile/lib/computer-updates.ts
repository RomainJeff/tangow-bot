import type { ComputerUpdate } from "@rakazo/contracts";
import { createComputerUpdates } from "@rakazo/core";
import { rpc } from "./api";
export const computerUpdates = createComputerUpdates({
  list: (ids) => rpc<ComputerUpdate[]>("computer/updates", { ids }),
  start: (botId, action) => rpc<ComputerUpdate>(`computer/${action}`, { botId }),
  releaseInterrupted: (id) => rpc("computer/releaseInterrupted", { id, workersStopped: true }),
  dismiss: (id) => rpc("computer/dismissUpdate", { id }),
});
