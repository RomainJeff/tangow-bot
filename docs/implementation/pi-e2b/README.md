# Pi and E2B implementation

The program prepares one temporary Pi worker per run while Rakazo retains the canonical session log and run orchestration.

The integration branch is `feature/pi-e2b-workers`. Each application slice targets that branch. The feature pull request stays draft until P6 validates the complete workflow. The maintainer decides the final merge. No deployment is part of P0.

## Dependency order

P0 proves the SDK contracts before the product runtime changes. P1 defines the worker and volume contracts. I1 validates infrastructure isolation before P3 can use it. P2 implements worker transport, followed by P3 execution and file migration, P4 computer and MCP integration, P5 durable compaction and recovery, and P6 validation.

The application baseline is `a34028112d43c75cb6e13d0b121d843015696de0`. The infrastructure reference is `09f242991ada8fdab2a9ce7a1fa847671d511874`. Infrastructure access and operational configuration remain outside this public repository.

## P0

[Issue #194](https://github.com/RomainJeff/rakazo-bot/issues/194) defines the SDK proof and its required handoff. A passing SDK probe does not establish worker security, durable recovery, or production readiness.
