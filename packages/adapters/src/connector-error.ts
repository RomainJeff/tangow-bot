import type { ConnectorFailureKind } from "@rakazo/adapter-kit";

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorFailureKind,
    message: string,
  ) {
    super(message);
  }
}
