import { buildSplit } from "./corpus.js";
import { COMMUNICATION_AND_COMMERCE } from "./holdout/communication-and-commerce.js";
import { OPERATIONS_AND_ACCESS } from "./holdout/operations-and-access.js";

/**
 * Final validation cases. Do not read this file or `holdout/` while tuning a classifier or its
 * prompt: the separation is procedural because the repository is public. Any edit changes the
 * manifest hash and needs a new corpus version before results can be compared.
 */
export const HOLDOUT_CASES = buildSplit("holdout", [
  ...COMMUNICATION_AND_COMMERCE,
  ...OPERATIONS_AND_ACCESS,
]);
