import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { askDraftFields } from "./draft-fields.js";
import type { DraftProposal } from "./draft-proposal.js";
import { acceptDraftProposal, DRAFT_CARDS, readDraftProposal } from "./draft-proposal.js";
import { draftMessage } from "./outbound-draft.js";

const args = {
  payload: { target_addresses: ["a@example.com", "b@example.com"], note: "Hello" },
  thought: "Mail the team.",
};
const proposal: DraftProposal & { card: "mail" } = {
  card: "mail",
  recipients: [
    {
      role: "to",
      path: ["payload", "target_addresses"],
      shape: "array",
      addresses: ["a@example.com", "b@example.com"],
    },
  ],
  body: { path: ["payload", "note"], value: "Hello" },
  unshown: [["thought"]],
};

describe("acceptDraftProposal", () => {
  it("reads a send with unknown field names back from where the proposal says", () => {
    const binding = acceptDraftProposal(args, proposal)!;
    expect(draftMessage(args, binding)).toEqual({
      recipients: [
        { role: "to", address: "a@example.com" },
        { role: "to", address: "b@example.com" },
      ],
      body: "Hello",
    });
    expect(askDraftFields(binding.fields!)).toEqual({ to: null });
  });

  it("reads a chat send's conversation as the id the call holds", () => {
    const chat = { channel: "C0GENERAL", text: "Hi", thread_ts: "1.2" };
    expect(
      acceptDraftProposal(chat, {
        card: "chat",
        conversation: { path: ["channel"], value: "C0GENERAL" },
        body: { path: ["text"], value: "Hi" },
        unshown: [["thread_ts"]],
      }),
    ).toEqual({ path: ["text"], proposed: "Hi", chat: { path: ["channel"] } });
  });

  it.each<[string, Record<string, unknown>, Partial<DraftProposal & { card: "mail" }>]>([
    ["a body the call does not hold", args, { body: { path: ["payload", "note"], value: "Hi" } }],
    [
      "recipients the call does not hold",
      args,
      { recipients: [{ ...proposal.recipients[0]!, addresses: ["a@example.com"] }] },
    ],
    ["an argument neither shown nor named", { ...args, attachment: "a.pdf" }, {}],
    ["an unshown argument the call lacks", args, { unshown: [["thought"], ["notes"]] }],
    ["an unshown argument holding the body", args, { unshown: [["thought"], ["payload"]] }],
    [
      "a subject read from the body",
      args,
      { subject: { path: ["payload", "note"], value: "Hello" } },
    ],
    [
      "a subject on two lines",
      { ...args, subject: "Hi\nBcc: x@example.com" },
      { subject: { path: ["subject"], value: "Hi\nBcc: x@example.com" } },
    ],
    [
      "recipients in objects that hold more than the address",
      { payload: { to: [{ address: "a@example.com", name: "A" }], note: "Hello" } },
      {
        recipients: [
          {
            role: "to",
            path: ["payload", "to"],
            shape: "objects",
            address: ["address"],
            addresses: ["a@example.com"],
          },
        ],
        unshown: [],
      },
    ],
    [
      "a copy line the call leaves out and no schema declares",
      args,
      {
        recipients: [
          ...proposal.recipients,
          { role: "cc", path: ["cc"], shape: "array", addresses: [] },
        ],
      },
    ],
    [
      "an indexed recipient that cannot receive edits",
      args,
      {
        recipients: [
          {
            role: "to",
            path: ["payload", "target_addresses", 0],
            shape: "one",
            addresses: ["a@example.com"],
          },
          {
            role: "to",
            path: ["payload", "target_addresses", 1],
            shape: "one",
            addresses: ["b@example.com"],
          },
        ],
      },
    ],
    ["no To", args, { recipients: [{ ...proposal.recipients[0]!, role: "cc" }] }],
    [
      "an empty body",
      { ...args, payload: { ...args.payload, note: " " } },
      { body: { path: ["payload", "note"], value: " " } },
    ],
  ])("refuses %s", (_, call, change) => {
    expect(acceptDraftProposal(call, { ...proposal, ...change })).toBe(undefined);
  });

  it("offers a copy line the call leaves out when the tool's schema declares it", () => {
    const binding = acceptDraftProposal(
      args,
      {
        ...proposal,
        recipients: [
          ...proposal.recipients,
          { role: "cc", path: ["cc"], shape: "array", addresses: [] },
        ],
      },
      { type: "object", properties: { cc: { type: "array", items: { type: "string" } } } },
    );
    expect(askDraftFields(binding!.fields!)).toEqual({ to: null, cc: null });
  });

  it("never accepts a card that leaves an argument unaccounted for", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc
            .string({ minLength: 1 })
            .filter((key) => !["payload", "thought", "__proto__"].includes(key)),
          fc.jsonValue(),
          { minKeys: 1, maxKeys: 3 },
        ),
        (extra) => {
          expect(acceptDraftProposal({ ...args, ...extra }, proposal)).toBe(undefined);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("readDraftProposal", () => {
  const { card: _, ...mail } = proposal;

  it("reads a filled card, its optional fields sent as null", () => {
    expect(
      readDraftProposal({
        name: DRAFT_CARDS.mail.name,
        value: {
          ...mail,
          recipients: [{ ...mail.recipients[0], address: null }],
          subject: null,
          account: null,
        },
      }),
    ).toEqual(proposal);
  });

  it.each([
    ["a card it was not offered", { name: "note_card", value: mail }],
    ["a mail without a body", { name: DRAFT_CARDS.mail.name, value: { ...mail, body: null } }],
    [
      "a recipient slot of an unknown shape",
      {
        name: DRAFT_CARDS.mail.name,
        value: { ...mail, recipients: [{ ...mail.recipients[0], shape: "set" }] },
      },
    ],
  ])("reads %s as no proposal", (_, answer) => {
    expect(readDraftProposal(answer)).toBe(undefined);
  });
});
