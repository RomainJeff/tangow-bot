import { describe, expect, it } from "vitest";
import { createAnswerOrder } from "./answer-order.js";

type Bot = { id: string; name: string; title: string; status: string };
const shown: Bot = { id: "b", name: "Old", title: "Old", status: "idle" };

/** Applies an answer the way a store does: keep the record when nothing may land. */
function land(merge: ((current: Bot | undefined) => Bot) | null, current: Bot): Bot {
  return merge ? merge(current) : current;
}

describe("answer order", () => {
  it("keeps both of two quick writes when the server answered them in reverse", () => {
    const order = createAnswerOrder();
    const nameWrite = order.next();
    const titleWrite = order.next();
    // The server applied the title first, so the name's answer is the newest row.
    let bot = land(
      order.write("b", titleWrite, ["title"], { ...shown, title: "New title" }),
      shown,
    );
    bot = land(
      order.write("b", nameWrite, ["name"], { ...shown, name: "New name", title: "New title" }),
      bot,
    );
    expect(bot).toEqual({ id: "b", name: "New name", title: "New title", status: "idle" });
  });

  it("keeps a field another write sent when a newer answer was read before that write", () => {
    const order = createAnswerOrder();
    const nameWrite = order.next();
    const titleWrite = order.next();
    let bot = land(order.write("b", nameWrite, ["name"], { ...shown, name: "New name" }), shown);
    bot = land(
      order.write("b", titleWrite, ["title"], { ...shown, title: "New title", status: "running" }),
      bot,
    );
    expect(bot).toEqual({ id: "b", name: "New name", title: "New title", status: "running" });
  });

  it("never lets an older answer for the same field overwrite a newer one", () => {
    const order = createAnswerOrder();
    const first = order.next();
    const second = order.next();
    const bot = land(order.write("b", second, ["name"], { ...shown, name: "Second" }), shown);
    expect(order.write("b", first, ["name"], { ...shown, name: "First" })).toBeNull();
    expect(bot.name).toBe("Second");
  });

  it("keeps records apart", () => {
    const order = createAnswerOrder();
    const forB = order.next();
    land(order.write("a", order.next(), ["name"], { ...shown, id: "a", name: "A" }), shown);
    const merge = order.write("b", forB, ["name"], { ...shown, name: "B" });
    expect(land(merge, shown).name).toBe("B");
  });
});
