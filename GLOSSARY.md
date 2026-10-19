# Glossary

Memory terms used in code, docs and UI. See [docs/memory.md](docs/memory.md).

**Memory**
A versioned Markdown document in a collection, with provenance, an access scope and a lifecycle status (proposed, active, withdrawn, superseded).
_Avoid_: fact, note, knowledge item

**Collection**
Where a memory lives and who may read it. One of three:
- **Personal**: one user's memories; never readable by a Space owner.
- **Bot**: one bot's memories; never readable by another bot.
- **Space**: memories published to a Space and readable by its members. A publication is an independent copy.
_Avoid_: Agent collection, Workspace, Shared

**Proposal**
A memory with status proposed. Not recalled until a person explicitly accepts it; editing does not accept it.
_Avoid_: draft, suggestion (reserved for classification), pending memory

**Evidence**
The citation stored with a proposal: source message, its version and the exact quoted text, checked by the server. Proves where text came from, not that it is true.
_Avoid_: proof, source (the message itself is the source)

**Withdraw**
Withdraw removes a memory from future recall; its history stays.
_Avoid_: delete, archive, disable
