import type { ModelCategory } from "@tangow/contracts";

export const MODEL_ROUTE_CASES: readonly {
  id: string;
  request: string;
  expected: ModelCategory;
  hasImages: boolean;
}[] = [
  {
    id: "rephrase",
    request: "Rephrase politely: Send the file today.",
    expected: "fast",
    hasImages: false,
  },
  {
    id: "extract",
    request: "Extract the invoice number: Invoice A-123, total 42 EUR.",
    expected: "fast",
    hasImages: false,
  },
  {
    id: "long-simple",
    request: `Extract the final order ID from this log. No analysis needed.\n${"Order X-100 shipped.\n".repeat(200)}Order FINAL-204 shipped.`,
    expected: "fast",
    hasImages: false,
  },
  {
    id: "reply",
    request:
      "Draft a reply to a customer whose delayed shipment arrived damaged, using our replacement policy and the earlier conversation.",
    expected: "everyday",
    hasImages: false,
  },
  {
    id: "synthesis",
    request:
      "Summarize the decisions, owners and next steps from these three project updates, resolving duplicate action items.",
    expected: "everyday",
    hasImages: false,
  },
  {
    id: "image-extract",
    request: "Read the date printed on the attached receipt.",
    expected: "fast",
    hasImages: true,
  },
  {
    id: "short-hard",
    request:
      "Can snapshot isolation violate this ledger's balance invariant? Find a counterexample.",
    expected: "complex",
    hasImages: false,
  },
  {
    id: "diagnosis",
    request:
      "Diagnose why acknowledged writes disappear only during leader failover. Compare competing hypotheses and design experiments to distinguish them.",
    expected: "complex",
    hasImages: false,
  },
  {
    id: "architecture",
    request:
      "Compare replication designs under partition, regional latency, deletion and recovery constraints. Identify incompatible requirements and justify the tradeoffs.",
    expected: "complex",
    hasImages: false,
  },
];
