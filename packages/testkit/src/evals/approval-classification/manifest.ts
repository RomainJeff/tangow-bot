/**
 * Frozen identity of the corpus. Changing any case changes a hash: bump the version and record the
 * new hashes in the same diff, so holdout edits stay visible in review.
 */
export const CORPUS_MANIFEST = {
  version: "2026-10-30.2",
  sha256: {
    development: "cc8c647c5fb60c24503dcdcca849ac26cbf0f4c08d6fe3c1eb1f289d851063ab",
    holdout: "dcde740a8f417d3416cc1a81801a7bb8ce88d994998a94c008c6644505258716",
  },
  labels: {
    author: "implementation agent (Claude model family)",
    reviewer: "independent corpus reviewer (Codex model family)",
    review: "reviewed",
  },
} as const;
