# Pi and E2B implementation

The program prepares one temporary Pi worker per run while Rakazo retains the canonical session log and run orchestration.

The integration branch is `feature/pi-e2b-workers`. Each application slice targets that branch. The feature pull request stays draft until P6 validates the complete workflow. The maintainer decides the final merge. No deployment is part of P0.

## Dependency order

P0 proves the SDK contracts before the product runtime changes. P1 defines the worker and volume contracts. I1 validates infrastructure isolation before P3 can use it. P2 implements worker transport, followed by P3 execution and file migration, P4 computer and MCP integration, P5 durable compaction and recovery, and P6 validation.

The application baseline is `a34028112d43c75cb6e13d0b121d843015696de0`. The infrastructure reference is `09f242991ada8fdab2a9ce7a1fa847671d511874`. Infrastructure access and operational configuration remain outside this public repository.

## P0

[Issue #194](https://github.com/RomainJeff/rakazo-bot/issues/194) defines the SDK proof and its required handoff. A passing SDK probe does not establish worker security, durable recovery, or production readiness.

## P1

[Issue #195](https://github.com/RomainJeff/rakazo-bot/issues/195) defines the worker, attempt and volume contracts. The [P1 handoff](P1-handoff.md) gives the messages, the migration, the state machine, the ownership and lease rules, and the AgentHomeStore procedure that P2, P3 and I1 consume. No product run uses a worker until P3 composes a provider. [How to add a worker provider](adding-a-worker-provider.md) explains how to support another provider, with Docker as the example.

## P2

[Issue #196](https://github.com/RomainJeff/rakazo-bot/issues/196) defines the worker channel, its journal and the stop contract. The [P2 handoff](P2-handoff.md) gives the protocol and its examples, the capability, sequencing and acknowledgement, the effect and stop states, the limits, the crash and retry matrix, and the local test runner that P3 and P5 consume. The channel does not depend on a harness. Pi is the only one implemented, and [How to add a harness](adding-a-harness.md) explains how to add another.
