import { describe, expect, it } from "vitest";
import {
  initialMaxSeq,
  isNewArrivalSeq,
  transcriptCanSnapAfterFrame,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "./transcript-scroll.js";

describe("transcriptIsNearEnd", () => {
  it("follows only while the viewport is within 80px of the latest message", () => {
    expect(transcriptIsNearEnd({ scrollHeight: 1_000, scrollTop: 421, clientHeight: 500 })).toBe(
      true,
    );
    expect(transcriptIsNearEnd({ scrollHeight: 1_000, scrollTop: 420, clientHeight: 500 })).toBe(
      false,
    );
  });
});

describe("transcriptCanSnapAfterFrame", () => {
  it("does not snap after the reader moves while the frame is queued", () => {
    const transcript = { scrollTop: 950 };
    expect(transcriptCanSnapAfterFrame(transcript, transcript, 950)).toBe(true);
    transcript.scrollTop = 920;
    expect(transcriptCanSnapAfterFrame(transcript, transcript, 950)).toBe(false);
  });

  it("does not snap a replacement transcript", () => {
    const queuedTranscript = { scrollTop: 950 };
    const replacementTranscript = { scrollTop: 950 };
    expect(transcriptCanSnapAfterFrame(replacementTranscript, queuedTranscript, 950)).toBe(false);
  });
});

describe("transcriptMovedDown", () => {
  it("does not treat an uninitialized baseline as downward movement", () => {
    expect(transcriptMovedDown(null, 920)).toBe(false);
    expect(transcriptMovedDown(950, 920)).toBe(false);
    expect(transcriptMovedDown(920, 950)).toBe(true);
  });
});

describe("initialMaxSeq / isNewArrivalSeq (B9)", () => {
  it("reads the highest seq of the messages present at mount", () => {
    expect(initialMaxSeq([{ seq: 3 }, { seq: 7 }, { seq: 5 }])).toBe(7);
    expect(initialMaxSeq([])).toBe(0);
    expect(initialMaxSeq([{ seq: null }, { seq: undefined }])).toBe(0);
  });

  it("only a seq beyond the line captured at mount is a new arrival", () => {
    expect(isNewArrivalSeq(8, 7)).toBe(true);
    expect(isNewArrivalSeq(7, 7)).toBe(false);
    expect(isNewArrivalSeq(3, 7)).toBe(false);
    expect(isNewArrivalSeq(undefined, 0)).toBe(false);
  });

  it("reopening an already-loaded thread replays no entrance: a fresh mount's own full history never crosses its own line", () => {
    // Shell's single, atomic snapshot commit means a `Transcript` remounted
    // for a thread the person already saw (leaving and coming back) mounts
    // with every one of those messages already in `messages` — never a
    // partial page that a later commit tops up. So the line this mount
    // captures sits at or above every one of them.
    const history = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
    const maxSeqAtMount = initialMaxSeq(history);
    for (const message of history) {
      expect(isNewArrivalSeq(message.seq, maxSeqAtMount)).toBe(false);
    }
    // A message that actually arrives live after that mount does cross it.
    expect(isNewArrivalSeq(4, maxSeqAtMount)).toBe(true);
  });
});
