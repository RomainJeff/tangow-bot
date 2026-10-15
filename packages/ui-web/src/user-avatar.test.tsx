import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserAvatar } from "./user-avatar.js";

describe("UserAvatar", () => {
  it("draws the initials in the person's bubble colour", () => {
    const html = renderToString(<UserAvatar initials="RJ" className="size-6" />);

    expect(html).toContain('data-slot="user-avatar"');
    expect(html).toContain("bg-chat-user");
    expect(html).toContain("text-chat-user-foreground");
    expect(html).toContain("size-6");
    expect(html).toContain(">RJ<");
  });

  it("shows the photo instead of the initials", () => {
    const html = renderToString(
      <UserAvatar initials="RJ" image="data:image/webp;base64,dGlueQ==" />,
    );

    expect(html).toContain('src="data:image/webp;base64,dGlueQ=="');
    expect(html).not.toContain(">RJ<");
  });
});
