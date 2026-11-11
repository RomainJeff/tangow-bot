import { createComputerUpdates } from "@tangow/core";
import { rpc } from "./rpc";
export const computerUpdates = createComputerUpdates({
  list: (ids) => rpc.computer.updates({ ids }),
  start: (botId, action) => rpc.computer[action]({ botId }),
  releaseInterrupted: (id) => rpc.computer.releaseInterrupted({ id, workersStopped: true }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
});
