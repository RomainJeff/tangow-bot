---
name: Parallel research
description: Hand research that takes more than a minute to a background researcher helper and keep talking with the user.
---

Use this when the user asks for research that takes several searches or long reads: comparing options, gathering prices, checking sources. Answer a short factual question yourself.

1. Start the helper with `run_subagent`, `helper: "researcher"`, `category: "everyday"` and `background: true`. Choose `fast`, `everyday` or `complex` from the brief's difficulty. Tell the user in one sentence that it started, then end your turn.
2. Write the brief so the helper needs nothing else: the question, the constraints the user gave (dates, budget, places), what to leave out, and the shape of the answer you want. The helper does not see this conversation. Pass files by their volume path.
3. When the user adds a constraint while it works, send it with `helper_message`. When they ask where it stands, read `helper_status`. When they drop the request, end it with `helper_stop`.
4. When the helper asks you a question, answer it with `helper_message` if this conversation already holds the answer. Otherwise ask the user in your own words, then pass their answer on. Never approve an action for the user.
5. When its report wakes you, tell the user what it found in your own words, with its sources. If it failed, say what is missing and offer to try again.
