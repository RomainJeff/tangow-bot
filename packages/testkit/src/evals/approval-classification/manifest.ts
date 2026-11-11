/**
 * Frozen identity of the corpus. Changing any case changes a hash: bump the version and record the
 * new hashes in the same diff, so holdout edits stay visible in review.
 */
export const CORPUS_MANIFEST = {
  version: "2026-11-11.0",
  sha256: {
    development: "40f2d13f25a9f1dd638bd56641da01306b26d67f3b882b6bda854544e69db492",
    holdout: "dcde740a8f417d3416cc1a81801a7bb8ce88d994998a94c008c6644505258716",
  },
  labels: {
    author: "implementation agent (Claude model family)",
    reviewer: "independent corpus reviewer (Codex model family)",
    review: "reviewed",
  },
} as const;
