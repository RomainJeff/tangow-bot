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

**Capture**
Creating a memory from a conversation. **Remember** is a human capture of one message and is active at once. **Extraction** is automatic capture during compaction and only creates proposals.
_Avoid_: save, ingest

**Recall**
Giving a run the active, authorized memories relevant to it, from the canonical library.
_Avoid_: retrieval, injection, search (search is the library's reading feature)

**Manifest**
The list of memory revisions (with access version) a run, summary or reply was given. Revalidated before each model and tool call; empty for runs that predate the memory library.
_Avoid_: context list, dependencies

**Withdraw**
Withdraw removes a memory from future recall; its history stays.
_Avoid_: delete, archive, disable

**History generation**
A counter on a conversation's history that a rewind or clear increments. Capture requests from an older generation become stale.
_Avoid_: epoch, version (reserved for messages and memories)
