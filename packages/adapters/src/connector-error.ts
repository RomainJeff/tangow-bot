import type { ConnectorFailureKind } from "@tangow/adapter-kit";

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorFailureKind,
    message: string,
  ) {
    super(message);
  }
}
