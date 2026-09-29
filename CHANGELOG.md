# Changelog

Notable product changes in Rakazo, newest first. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### 2026-09-30

#### Fixed

- A bot no longer ends a task with only its step chips and no answer: it is prompted to reply, and if it still stays silent you get a short notice that it could not finish.
- After you hand a bot's screen back (I'm done, Skip, or your control times out), the bot now remembers what it had already done and looks at the screen again before carrying on, instead of starting over, assuming the step is finished, or repeating its internal resume instructions to you.
- A bot now hands you its screen only after its previous step has finished, so its Needs you card matches what the screen shows.
- When you write to a bot while you hold its screen, it now looks at the screen before answering and leaves it with you until you press I'm done or Skip, instead of misreading your message or closing the screen you were using.
- When you reopen a bot's screen after its task ends or its computer wakes, the browser is back on the pages it had open instead of a blank new tab.
- Opening a bot's screen no longer fails now and then with "Bad Gateway" after a pause.

### 2026-09-28

#### Changed

- What a bot tells you while it works ("I'll check the calendar…") now stays on screen only until it answers, instead of piling up as separate messages that marked the chat unread and reached linked messaging apps; it is kept when the bot stops to ask you something or when it is all the bot said.

#### Fixed

- A bot's report, routine digest and notification no longer glue two sentences together where it paused to use a tool ("famille de 5.Les moteurs"): each part now starts its own paragraph.
- A scheduled check told to stay quiet when there is nothing to report now stays quiet, instead of ending on "I completed the tool step but could not produce a final response. Please ask me to continue." after looking things up.
- A bot that runs several searches or page reads at once no longer stops midway with "Transaction API error: Unable to start a transaction in the given time.": a brief rush on the server now waits for a free connection instead of failing the reply.
- A bot that has answered you in chat bubbles now simply stops, instead of adding a closing line like "Message sent." or "Nothing more to do", or ending on "I completed the tool step but could not produce a final response. Please ask me to continue." after a reply that was already complete.
- Chat bubbles a bot sends in one go now appear in the order it wrote them, instead of arriving shuffled so that a conclusion could land before its context.
- A bot no longer posts the same sentence twice when its opening remark and its first chat bubble say the same thing.
- A report another bot sends on its own, like a scheduled inbox check that found nothing, no longer lands in your chat as a raw "Update from …" message when the bot it reports to decides it needs no reply; an answer to something that bot asked for is still always passed on.
- Web searches and page reads no longer fail with a bare "fetch failed" when a connection drops once: a brief network hiccup is retried, and an error that remains now names its cause.
- A bot's reply no longer says it "thought for 24h" after waiting on your answer to one of its questions: the time shown now counts only the work since you answered.

### 2026-09-27

#### Added

- **Long-pressing a message on mobile opens a native sheet with quick reactions, its actions and Select text.** The sheet replaces the system action sheet; Select text shows the message on its own so you can select and copy just part of it.

#### Changed

- Long-pressing a chat in the mobile inbox now opens its pin, notification and section options in a native sheet you can swipe down to close, instead of a custom overlay.

#### Fixed

- Every link in a thread is now clickable on web, desktop and mobile: URLs you type in your own messages, bare `https://` and `www.` addresses in bot replies on mobile, and Markdown links that start with `www.` instead of `https://`; tapping a link on mobile now always opens it instead of sometimes doing nothing.

### 2026-09-26

#### Added

- **Bots can complete multi-step web page tasks in one go when a decision provider is connected.** A Space owner connects an OpenRouter key in Settings → Browser on web and desktop; bots then hand a page task such as a form, filters or an onboarding flow, with the values they know, to a fast decision model that clicks, types and picks drop-down options step by step instead of the bot reading the page at every step. It stops and asks before paying, ordering, deleting, sending or a final submission, and hands back when a value is missing or the page is unclear. See [computer runtime](docs/computer-runtime.md) and [self-hosting](docs/self-host.md).
- **Routines woken by a webhook, Git event or message can run without asking before every action.** On web, a new "Ask before every action" switch appears once such a trigger is added; it stays on by default, and turning it off lets those runs follow your usual action confirmations instead of pausing on each tool call.

#### Changed

- While a bot works in a thread, its avatar next to the working line now buzzes left and right on web, desktop and mobile, and stays still when reduced motion is on.
- A routine woken by a webhook, Git event or message now shows up in the bot's thread on web, desktop and mobile as its own collapsible run card, one per routine, instead of posting its instructions and the raw payload as a message from you; like other background routines, it only notifies you when "Notify me on every run" is on.

#### Fixed

- Bots now fill drop-down menus on web pages by the option they read and no longer switch to screen clicks when a page shows hidden ad or tracker frames.
- The iPhone app opens again instead of closing right after launch: the launch screen's bot avatar called a colour helper that a merge had removed.
- Tapping a bot's push notification on mobile now opens that bot's conversation, or the group it spoke in, instead of just launching the app on the inbox.

### 2026-09-25

#### Changed

- Bots now write in chat like a capable colleague rather than a help desk: shorter answers in plain prose, in the language you write in and with the tu or vous you use, without stock openers, closing offers or invented figures and menu paths, and in plain text on messaging apps, while the bot's own instructions, your stated preferences and any format you ask for still take precedence.

#### Fixed

- The mobile message field now looks and responds like the web one: a centred placeholder, the same tight shadow instead of a grey blur, an ink caret, a ring while you type, working dots while a bot runs, a send arrow and buttons that react to your touch, and a light tap under your finger when you send or stop.
- Question and approval cards in the mobile app now carry the same soft shadow and ring as on web instead of a flat grey outline, and the jump-to-latest button floats above the thread as it does on web.
- Scrolling a long conversation in the mobile app no longer stutters: the thread stops redrawing every message while you scroll, type, or when a background refresh brings nothing new.
- An answered question card on mobile no longer glues its topic label onto the question or repeats the question under a lone dot; on web and mobile a single answered question now shows just the answer beneath it, and answered multi-question cards drop the progress dots.
- The mobile message field no longer leaves an empty gap to the right of the attach button.
- The mobile app now follows your device's light or dark setting when its own Appearance preference is "System", instead of always opening in dark mode regardless of that setting.

#### Added

- **The mobile app now opens on a bot waking up, in the shape and color of your first pinned bot.** It replaces the static blue square on black: a sleepy bot opens its eyes, glances around and smiles while the app loads, then fades into your inbox. With no bot yet, it shows a plain monochrome placeholder instead.

### 2026-09-24

#### Added

- **iPhone notifications now show the bot's own avatar.** When a bot finishes, fails or needs you, the notification carries its shape and colour with the Rakazo icon as a small badge, the way messaging apps show a contact, instead of the bare app icon. It follows the organic avatar style; with the robot style the notification keeps the app icon.

### 2026-09-23

#### Fixed

- A bot no longer writes fake tool calls like `[tool web_search(...)]` into its replies instead of running the tool; its earlier tool calls now reach the model as real tool calls, and anything that still has to be shown as text reads as a plain note.

### 2026-09-22

#### Fixed

- On iPhone and iPad, the Rakazo icon now shows a badge with the number of unread conversations when a bot finishes or needs you, and the badge drops as you read them; it never appeared before, so a message waiting in a closed app gave no sign on the home screen.

### 2026-09-20

#### Added

- **A bot now remembers what you told it in passing, without being asked to.** Whenever a long conversation is condensed, the bot goes back over the stretch it just archived and writes the durable things it learned — how you want to be addressed, what you decided, the names of the repositories, channels and projects you work in, the corrections you made to it — into its Knowledge document under a dated "Learned" heading, where you can read, edit or delete them. Nothing is kept from a group chat or a messaging channel, secrets are stripped before anything is written, and a batch that taught it nothing leaves no trace.
- **Agent runs can now be exported to an observability service, so you can see what a bot actually did.** An operator who sets a key pair for a Langfuse or other OpenTelemetry endpoint gets every run as a tree — the run, each turn, each tool call and its result, with prompts, responses, token counts and cost — while a deployment that sets nothing behaves exactly as before. Traces carry full conversation content and the user, session and bot identifiers, and there is no per-user opt-out: configuring an endpoint exports every run of every user on the deployment. See [docs/self-host.md](docs/self-host.md).

#### Changed

- A bot now keeps every fact it memorises instead of only the last one. Each thing it commits to memory is added as its own line in the bot's Knowledge document, so a conversation where it notes three preferences leaves all three there; editing or clearing that memory from the Knowledge screen still replaces it outright, and the bot is now told to record a preference or a correction the moment you state it rather than at the end of the conversation.
- A bot now remembers the tools it ran on an earlier turn — which tool, on what, and what came back — instead of only its own reply, so it stops re-reading the same file or repeating a search it already did, and a compacted conversation finally records the actions it took.

#### Fixed

- Your usage totals now count what condensing a long conversation costs. The summarising call spends real tokens on every compaction and was recorded nowhere, so a long thread — where that call is often the most expensive one — read as cheaper than it actually was.
- A conversation you had edited an earlier message in could stop condensing itself for good, leaving the bot to re-read the same long history on every reply and never record anything new in what it remembers. Editing a message deletes the ones that followed, and the leftover hole in the numbering made the condensing step refuse to run. It now condenses across the deleted stretch, and any conversation already stuck this way recovers on its own.
- A bot now brings up what it remembers from the first message of a new conversation, instead of only once that conversation had grown long enough to be condensed. The same number of remembered facts is pulled in as before.
- A bot on Anthropic, OpenAI or OpenRouter now sizes its conversation history by the model's real context window like an OpenAI-compatible connection already did, instead of falling back to a fixed number of messages and cutting the thread short.
- A bot re-reading a thread no longer mistakes another bot's message for something it decided itself: a message from one of your other bots now stays attributed to that bot in the conversation history, the same way it is shown when the message first wakes the bot, and the bot's own past replies are marked distinctly so a message that merely starts with "Assistant:" cannot pass for one.
- In a group chat, a bot re-reading the thread no longer takes another member's work for its own: a post from another bot in the group now stays attributed to that bot by name, and a handoff between two members reads with their names instead of internal identifiers.
- A bot now measures what the rest of its run costs — its instructions, what it remembers, its scratchpad, the roster of your other bots, its tool descriptions, and the message you just sent along with any files and quoted reply attached to it — before deciding how much of the conversation fits, instead of assuming a fixed amount. A lean bot keeps more of the thread, and a bot with a large memory or many connected tools stops crowding its own context window.
- A bot re-reading a long conversation now recognises its own past replies as its own turns rather than as text quoted back to it, so it keeps its voice and its earlier commitments instead of restating them, and no message from a person or another bot can dress itself up as something the bot decided. Replayed turns are counted as costing nothing, since they were already paid for on the run that produced them.

### 2026-09-19

#### Changed

- The mobile avatar now matches web and desktop: a bot's organic body is drawn by the same living engine, so it morphs, blinks and squashes instead of sitting still, and it glances around with a changing mood while a run is working. Reduced motion still gets a single settled frame, and the shape picker now lists exactly the shapes that exist.
- A bot now fills its model's context window with as much of the conversation as actually fits, measured in tokens rather than a fixed message count, and always starts that window on one of your messages instead of mid-reply; a thread of long pastes is also condensed as soon as it grows heavy, instead of waiting for a hundred messages.
- A long conversation's compacted memory is now a structured checkpoint — goal, constraints, progress, decisions, next steps and critical context — instead of a loose paragraph, so a bot picking a thread back up keeps what was decided and what is still open; an unusually long summary is trimmed rather than left to stall compaction for the rest of the thread.
- A background routine's run card now reads like a message: its summary renders as formatted text (headings, lists, bold, tables, links) rather than raw markdown, the card is a touch wider to fit it, and a routine you're subscribed to is marked with a small bell instead of a coloured edge and a "Subscribed" label while still opening expanded; images inside a summary are never loaded. Same on web, desktop and mobile.
- The bot's thread header drops the "Computer & routines" wording for two icon buttons, a screen and a gear, that open the computer or the settings panel and mark whichever is open, the bot name and both icons now respond on hover so it's clear they're clickable, and the settings panel's own duplicate switch is gone; on web and desktop.
- Saving a bot's settings no longer means scrolling to the bottom of the form: on web and desktop Save, Export and Clear conversation ride a footer pinned to the bottom of the panel, and on mobile Save moves to an always-visible button in the nav bar.

#### Fixed

- iPhone push notifications come back on their own. A device whose push token had gone stale — after the app moved to a new Expo project and bundle id — kept failing to register silently, so the server went on pushing to a token nobody owned and nothing ever asked the phone for a new one. Registration failures now surface (in the notification settings screen when you flip the toggle, in the device log otherwise), and the server drops a token Expo reports as dead so the next time you open the app it registers a fresh one.
- On a phone browser the bot settings footer no longer lets the form scroll over it: Save, Export and Clear sit in a footer fixed to the bottom of the panel with Save a full-width, comfortably tappable button, and the panel's close button now stays in view while the content scrolls. On web and desktop.

### 2026-09-18

#### Added

- **Bots wear a redesigned organic avatar.** Each bot now picks from twelve softly filleted geometric silhouettes (disc, pebble, hexagon, shield, teardrop, star and more) drawn from a seven-hue palette, plus two special bodies you can choose — ink and white — with tall bar eyes that keep a fixed size and shift with the shape, an eye colour chosen for contrast (white on the ink body, ink on the rest), and an outline on the white body so it still reads on a light background. The look is identical on web, desktop and mobile, keeps its glow and breathing while a bot works, and honours reduced motion; existing bots move to the nearest new hue automatically.

#### Changed

- When a bot sends several messages in a row, they stack under a single avatar, name and time instead of repeating the header on each, and each message shows its time on hover.
- The message box responds as you use it: it lifts on focus, its send arrow leans up on hover, and it settles gently when a message is sent.
- Answer a bot's question straight from the main message box: typing a reply while a question card is waiting now resolves it and the bot continues instead of being refused, while its buttons stay a shortcut and approval or secret prompts keep their own dedicated cards.

#### Fixed

- A bot's question card reads cleaner: the grey label bar above each question is gone, multi-select options show what you picked by filling in rather than a ☑/☐ glyph, its progress counter sits next to the step dots, and the duplicate "type your own answer" line is dropped so only the field remains.
- Small status marks in a conversation (the clock, the check and the arrow on activity and card lines, and the chevrons on proof and hand-off lines) are drawn icons now, so a screen reader no longer reads them out as "check mark" or "rightwards arrow"; and a running sub-agent's status no longer pulses forever.
- The message box's text field fills the full width of the bar again instead of wrapping into a narrow column.
- With a long draft the message box keeps a tidy rounded shape with a quiet slim scrollbar, instead of stretching its pill ends into oversized curves.
- A long message you send now hugs the right edge of the conversation like a short one, instead of drifting to the left once it reached its maximum width.
- A bot's question card now sits a little lower under the bot's name instead of pressing right up against it.
- A card in a conversation shows its full soft shadow again, including the bottom-right corner, instead of having it clipped at the right edge of the scroll area.
- The text and placeholder in the message box are vertically centred in the bar now, instead of sitting slightly high.
- After you answer a bot's question, it responds to what your reply adds instead of going back over the conversation to re-explain or re-ask points already settled, and a bubble that only rewords one it already sent (even after a pause) is no longer posted again.

### 2026-09-17

#### Added

- Quote selected text when replying: select part of a message and the reply carries that excerpt.
- Per-bot "Notifications" switch: get notified when a bot finishes or needs input. Name, title, description, instructions and avatar now autosave on blur.
- Every run's system instructions now state the current date and time (UTC), so bots judge deadlines, recency and scheduling from the real present instead of guessing it from training data or quoted timestamps.

#### Changed

- The conversation column is wider on large screens (800 px instead of 668), so replies and the message box use more of a desktop window.
- Rakazo's pages, text and borders move to the Quiet palette (warm off-white page, ink text, hairline borders) in light and dark mode, on web, desktop and mobile.
- On web and desktop the app is two panes: a narrower bots sidebar and the conversation in a centred column, with the thread header reduced to the name and one button.
- The bot's computer and routines now open over the conversation from the "Computer & routines" button in the thread header and close with Escape or the X, instead of holding a third column open beside the thread.
- Bots now wear their organic avatar by default on web, desktop and mobile; a working bot shows its glow instead of a spinning ring, and the robot look stays available in Settings › Appearance.
- The message box is a single rounded capsule: attach and dictate sit inside it, Send appears only once there is something to send, and Stop joins it while the bot works.
- Bot replies read as text on the page with the bot's avatar, name and time instead of grey bubbles; what a bot asked another bot shows as a one-line note between messages, and a reply's reasoning folds under "Thought for … · n steps".
- Routine runs, files, charts, connections and other cards in a conversation share one quiet surface: a soft corner, a hairline and no shadow.
- A voice call now takes the conversation's place: the bot's avatar and glow, its live words, quick replies, and round controls to mute or end the call.
- A bot's request for your decision is the one framed card in the conversation, shown under its avatar and name like any other reply: the question, what it changes, and its choices as capsules.
- On mobile, the bots list is a quiet roster (avatar, name, one status line) and a conversation's header carries its title, its bots and a shortcut to the computer.
- On mobile, a conversation reads like the web one: bot replies as text with avatar, name and time, notes between bots centred, reasoning folded under "Thought for … · n steps", and a single rounded message box whose Send appears when there is something to send.
- On mobile, a bot's request for your decision is the one framed card in the conversation, with full-width capsules you can reach with a thumb, and every other card sits on the same quiet surface.
- While a bot works, the conversation shows one calm line — its avatar, what it is doing and the elapsed time — instead of a blinking loader.
- Message actions appear in a small floating pill at the top corner of a message when you hover or focus it, and bot replies use the full width of the conversation.

#### Fixed

- Your own messages show as your right-aligned bubble again, without a generic "Bot" name and star avatar above them.
- On the macOS desktop app the window's traffic-light buttons now sit level with the sidebar header controls and keep their own room, instead of riding high and crowding the collapse and search buttons.
- The message box no longer leaves an empty gap next to the dictate button when it is empty; Send simply appears in place once there is something to send.
- The floating action pill on a message (reply, react, copy, …) stays hidden until you need it: on a pointer it appears on hover or focus and is fully clickable, and on a touchscreen a tap on the message reveals it with finger-sized buttons and a tap away hides it, so it no longer sits permanently on every message.
- A note between messages (a hand-off or a message received from another bot) no longer shows a stray "Message" reply preview above it, and a reply to such a note previews the message's text.
- Opening a voice call now closes the computer and routines panel so the call is never hidden behind it, and on narrow windows the conversation behind an open panel is no longer reachable by keyboard.
- A message a bot received from another bot shows again as a centered note between messages, not as a reply from an unknown "Bot".
- A bot's question or approval shows the bot's avatar, name and time again, and reads the real bot name instead of a generic "Bot" in a one-to-one thread.
- A model's special control tokens (like `<|eos|>`, `<|im_end|>`, role markers) no longer leak into a bot's message as visible text; they are stripped from the model's output whatever model you pick, so switching the default model can't garble replies with stray tags.

### 2026-09-16

#### Fixed

- A bot no longer posts the same answer twice in a row: a message it already sent is not posted again, whether it repeats it as another message or as its final reply, and it is told to end its turn once its messages have said everything.

### 2026-09-15

#### Fixed

- A conversation no longer goes blank when it holds a message this version cannot display: the part it does not recognise is skipped and the rest of the thread opens normally, on web, desktop and mobile.
- A bot-to-bot chat now opens on its latest messages instead of the oldest, so the newest exchange is visible without scrolling; the oldest-first order is unchanged.
- On desktop, a bot-to-bot chat's title no longer sits under the macOS window buttons.

### 2026-09-14

#### Fixed

- A sub-bot's routine no longer streams its live text or activity lines into the thread while it runs — the run card is the only surface, so a routine appears as just its card (running → done) with nothing streaming beside it.

### 2026-09-13

#### Fixed

- A sub-bot's scheduled routine no longer drops a mid-run "nothing to report" narration bubble into its thread alongside the run card — the card is its only trace, so the routine stays a single, clean entry.

### 2026-09-12

#### Added

- **Routine runs leave a visible trace.** A sub-bot's scheduled routine (Alfred's inbox check, Warren's market point, ...) now shows a run card in its own thread — started, running, completed, or failed, timestamped, with a one-line summary and the full result tucked in an expandable detail — instead of a free "done"/"nothing to report" reply. A "notify me every time" toggle in the routine's setup controls whether that run also pages you; off by default, so a routine stays a quiet, browsable trace until you ask to hear from it.

#### Fixed

- **Claudius's replies about a sub-bot's report now reach you.** When a sub-bot hands a result to Claudius, Claudius's own reply was being silently dropped from your view; it's now a normal, visible, notifying message like any other reply. Sub-bots' own delegated work stays out of your thread, unchanged.

### 2026-09-10

#### Fixed

- A sub-bot no longer pings you when it finishes background work: neither a run another bot delegated to it (reported back to that bot) nor its own scheduled routine (which reports to its orchestrator) pushes you a "finished"/"failed" notification. Runs you started, your direct conversations with any bot, a top-level bot's own routine brief, and requests for your input (approvals, answers, takeovers) still page you.

### 2026-09-08

#### Added

- Connect Slack, WhatsApp Business Cloud, or Telegram DMs to a bot from Messaging settings, alongside iMessage/SMS. Each app can use a different bot. Group conversations remain iMessage-only.
- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

#### Fixed

- Connector artwork is back on the mobile Integrations screen — tiles show each app's logo again instead of a bare name.
- The bot's computer screen loads behind Cloudflare Access on mobile: the embedded view now sends the service-token headers instead of bouncing to the Access login page.

### 2026-09-06

#### Added

- **Ask several questions in one card.** `ask_user` can pose up to four questions at once — a counter and previous/next navigation, tappable options (single- or multi-select), an always-available free-text "Other", and a "Skip" on optional questions — all answered and sent in a single step, then frozen into a summary.
- **Skills panel on mobile.** Browse, install and manage skills from the phone, not just the web app.
- **Skills repositories as marketplaces.** Point a marketplace at any GitHub repository laid out the `npx skills` / skills.sh way — `skills/`, `.claude/skills/`, `.agents/skills/`, or a bare `SKILL.md` at the root — alongside the usual `.claude-plugin/marketplace.json` marketplaces. Repositories of this kind get their own badge in the panel so you can tell them apart.
- **Install several skills in one go.** Multi-select in the Browse tab installs the whole selection in a single pass instead of one round trip per skill.
- **Plugins hosted in their own repository.** A repository that *is* a single plugin, or a plugin whose directory is itself a skill, installs like any other marketplace entry.
- **Import a `.skill` file as a zip.** The import picker now accepts `.zip` bundles on top of plain `SKILL.md` text and `tar.gz`, including the zips the macOS Finder produces from "Compress".
- **Choose who each skill reaches.** Every skill is Global, Specific, or off, with per-agent toggles in agent settings and a matching control in the Skills list.
- **Search and filter your skills**, with the toolbar pinned to the top of the list.
- **Agents get their own Skills section** in their settings — install-only, so agent-level changes can't disturb the shared library.
- **One Customize overlay.** Integrations and Skills now live side by side in a single overlay instead of two separate destinations.
- **A profile photo of your own**, on web, desktop and mobile.
- **See which tool a bot is on.** The "working" label next to the bot avatar shimmers and names the tool currently running.
- **Groups of one bot** are allowed, and a group can carry a description that is injected into its bots' prompts.
- **Threads mark day and time when they resume**, so a conversation picked up hours later reads in order.

#### Changed

- **A message sent while a bot is working is addressed, not just noted.** When you write mid-task, the bot now replies to that message explicitly before finishing its turn.
- Group avatars pair a lone bot with the user's initials instead of showing a half-empty tile.
- 1080 empty entries in the message catalogs were translated — far fewer English strings leaking into other locales.
- Renaming a skill keeps its bundle files.
- Installed plugin trees are capped at 50 MiB, and a marketplace update writes its manifest only after every install has succeeded — a failed update no longer leaves a manifest describing plugins that aren't there.

- **Type your own answer to a multiple-choice question.** A bot's choice question always offers a free-text answer instead of forcing one of the buttons; on a single-choice question the typed answer and a tapped option are mutually exclusive, so only one is sent.
- A delegated bot's `ask_user` is actually answerable; `message_user` no longer collides with it.
- Groups without a description no longer break the web settings screen.
- The gap between the composer and the on-screen keyboard is closed.
- A zip whose own entries collide is reported as a bad bundle instead of installing something half-formed.
- Removing an installed plugin is guarded against path traversal.

### 2026-09-05

#### Added

- **Display agent steps.** A setting on web and mobile that shows what the bot did to get to its answer, expanded into a per-tool list with the details of each call.
- **Skills live on the filesystem.** Skills are stored as `SKILL.md` files under `DATA_DIR`, edited in the app with live validation, and read and written by the bot's own `skill_*` tools. Existing skills are migrated at boot.
- **Skills are scoped per bot.** A skill can be available to everyone or to a chosen set of bots; the slash picker in a thread only offers what the active bot can actually use. Skills a bot creates stay with their creator. Renames, deletions and bot duplication carry the scoping with them.
- **Open a bot-to-bot chat** straight from a peer chip on mobile.
- **`chattyReplies`, per bot** — a setting for how much a bot talks while it works.

#### Changed

- Bots stop narrating their own work through `message_user`.
- The server picker is reachable from settings, and the Cloudflare Access token sits behind a toggle instead of cluttering the form.

#### Fixed

- Threads that stored reasoning blocks load again.
- The window chrome stays reachable when the bots sidebar collapses.

#### Reverted

- The live, collapsible reasoning trail and the grouping of consecutive messages from the same speaker were both shipped and pulled back the same day.

### 2026-09-04

- A bot-level `chattyReplies` setting lands, and the stack is reconciled with upstream after a rebase.

### 2026-09-03

#### Added

- **Edit and resend a message.** Editing a message rewinds the thread to that point, on web and on mobile, so a bad turn can be replayed instead of worked around.
- **A Files tab in a bot's knowledge**, next to its memory and skills.

#### Changed

- Integrations are grouped into Featured, All and Installed, with what you already installed at the top.
- The rest of the web chrome is themed for light mode.
- Chinese strings seeded for the mobile integrations sections.

### 2026-09-01

#### Added

- **Reach a self-hosted server behind Cloudflare Access from mobile.** The service token can be entered in the server sheet or baked in at build time, and the Android notification poller sends it too. [Setup guide](docs/self-host.md).
- **Edit a bot's instructions on their own**, without walking through the rest of its settings.
- `curl`, `jq` and `poppler-utils` are available in the computer sandbox image, so bots can fetch, parse and read PDFs without improvising.

#### Changed

- Composio identities are scoped per space.

### 2026-08-31

#### Added

- **Reach a self-hosted server behind Cloudflare Access from the desktop app.** When the setup probe fails it now says why — transport error, network error code, or a redirect it never expected — instead of failing blank.
- **Bots keep a chosen organic avatar shape**, and colour and shape moved into a single avatar popover.

#### Changed

- The Cloudflare Tunnel moved into the base Compose file, so it is part of the standard self-hosted stack.
- The tool trail is spaced off the reply below it.

### 2026-08-30

- Docker Compose setup for macOS.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
