# Scoped team-chat relays

A personal team-chat gateway can accept a configured automation sender alongside
its linked human owner. Keep `TEAM_CHAT_REQUIRE_LINKED_IDENTITY=true` and set
`TEAM_CHAT_TRUSTED_RELAYS` to a JSON array in the private deployment environment:

```json
[{"provider":"slack","botId":"target-bot-id","workspaceId":"workspace-id","senderId":"relay-bot-user-id","conversationKeys":["channel-id"]}]
```

Every field is an exact match. Use the Slack bot **user** ID as `senderId`, not the
app ID or bot ID. Messages from other bots, workspaces or channels remain rejected.
Authorization is checked both at reception and before a queued request starts.
Slack still verifies the event signature at the provider boundary. Keep signing
secrets and tokens in the deployment secret store, never in this JSON or a skill.

Configure a separate Slack app for the inbound automation, preserving the CEO
app's native Events URL. Invite both apps to each permitted channel. The relay
posts a CEO mention in the original channel with the original `thread_ts`, author,
message text and source link. The CEO's reply goes directly to that thread under
its usual action policy; the generic bot webhook is not used. Filter bot messages
and duplicate events before relaying, and preserve only useful follow-ups.

Mail can use the same relay through a private intake channel. Receive mail through
a provider webhook or actual IMAP IDLE, preserve sender, recipients, Reply-To,
Message-ID and References, and let the bot respond with its existing mail tools.
Seed an IMAP UID cursor before activation to avoid importing old mail. Do not use
a scheduled inbox sweep or expose mail content in a customer Slack channel.

The web and desktop Messaging settings provide **Open chat** for stored team
conversations, including author attribution, delivery state and an **Open in
Slack** link. This history is read-only; continue the conversation at its source.
The shared history API enforces the current owner and space. Native mobile does
not yet provide this history view.

Removing a relay entry revokes future reception and queued requests on the next
API configuration reload. To stop intake immediately, deactivate the inbound
workflow. Existing transcripts remain available.
