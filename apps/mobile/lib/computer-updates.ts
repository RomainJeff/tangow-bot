import type { ComputerUpdate } from "@tangow/contracts";
import { createComputerUpdates } from "@tangow/core";
import { rpc } from "./api";
export const computerUpdates = createComputerUpdates({
  list: (ids) => rpc<ComputerUpdate[]>("computer/updates", { ids }),
  start: (botId, action) => rpc<ComputerUpdate>(`computer/${action}`, { botId }),
  releaseInterrupted: (id) => rpc("computer/releaseInterrupted", { id, workersStopped: true }),
  dismiss: (id) => rpc("computer/dismissUpdate", { id }),
});
