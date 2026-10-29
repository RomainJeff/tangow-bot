import { buildSplit } from "./corpus.js";
import { COMMERCE_AND_ACCESS } from "./development/commerce-and-access.js";
import { COMMUNICATION } from "./development/communication.js";
import { OPERATIONS } from "./development/operations.js";
import { RECORDS_AND_FILES } from "./development/records-and-files.js";

/**
 * Development cases: tune prompts against these only. Every service is invented; labels follow
 * the behavior each description documents, never the tool name.
 */
export const DEVELOPMENT_CASES = buildSplit("development", [
  ...COMMUNICATION,
  ...COMMERCE_AND_ACCESS,
  ...RECORDS_AND_FILES,
  ...OPERATIONS,
]);
