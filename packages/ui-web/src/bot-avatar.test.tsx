import { avatarIdentitySeed, SHAPES } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvatarStyleProvider } from "./avatar-style.js";
import { BotAvatar } from "./bot-avatar.js";

describe("BotAvatar", () => {
  it("renders distinct SVG gradient IDs for concurrent working avatars", () => {
    const html = renderToString(
      <div>
        <BotAvatar color="#8B5CF6" status="running" variant="robot" />
        <BotAvatar color="#10B981" status="running" variant="robot" />
      </div>,
    );

    const gradMatches = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(gradMatches).toHaveLength(2);
    expect(gradMatches[0]).toBeTruthy();
    expect(gradMatches[1]).toBeTruthy();
    expect(gradMatches[0]).not.toBe(gradMatches[1]);

    expect(html).toContain(`stroke="url(#${gradMatches[0]})"`);
    expect(html).toContain(`stroke="url(#${gradMatches[1]})"`);
  });

  it.each(["running", "queued", "leased", "waiting_input", "waiting_takeover"])(
    "renders active working ring for %s status",
    (status) => {
      const html = renderToString(<BotAvatar color="#3B82F6" status={status} variant="robot" />);
      expect(html).toContain("<svg");
      expect(html).toContain("rakazo-bot-avatar-ring");
    },
  );

  it("keeps the working ring mounted when idle so its timeline does not reset", () => {
    const html = renderToString(<BotAvatar color="#F59E0B" status="idle" variant="robot" />);
    expect(html).toContain('data-working="false"');
    expect(html).toContain("rakazo-bot-avatar-ring");
  });

  it("defaults to the organic avatar when no style preference is provided", () => {
    const html = renderToString(<BotAvatar color="#D9508A" identity="maya" status="running" />);
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).not.toContain("rakazo-bot-avatar-ring");
  });

  it("draws the organic avatar with the bloub engine", () => {
    const html = renderToString(
      <BotAvatar color="#D9508A" identity="maya" size={28} status="running" variant="organic" />,
    );

    expect(html).toContain("rakazo-organic-avatar");
    expect(html).toContain('data-working="true"');
    expect(html).toContain("<mask");
    expect(html).not.toContain("rakazo-bot-avatar-visor");
  });

  it("punches two eye holes into an idle body", () => {
    const html = renderToString(<BotAvatar color="#00C46A" identity="maya" variant="organic" />);

    expect(html).toContain('data-working="false"');
    expect(html.match(/fill="#000"/g)).toHaveLength(2);
    expect(html).toContain('fill="#00C46A"');
    // A mid-luminance hue keeps ink eyes and no body outline.
    expect(html).toContain('fill="#101014"');
    expect(html).not.toContain('stroke="#17181A"');
  });

  it("uses white eyes on a dark body and inks a pale body", () => {
    const dark = renderToString(<BotAvatar color="#17181A" identity="ivo" variant="organic" />);
    expect(dark).toContain('fill="#FFFFFF"');

    const pale = renderToString(<BotAvatar color="#FFFFFF" identity="nour" variant="organic" />);
    expect(pale).toContain('stroke="#17181A"');
    expect(pale).toContain('fill="#101014"');
  });

  it("generates distinct organic silhouettes for distinct bot identities", () => {
    const maya = renderToString(<BotAvatar color="#D9508A" identity="maya" variant="organic" />);
    const github = renderToString(
      <BotAvatar color="#D9508A" identity="github" variant="organic" />,
    );

    expect(maya).not.toEqual(github);
  });

  it("renders the picked shape seed, wrapping around the bloub shape catalogue", () => {
    const body = (html: string) => html.match(/<mask[^>]*><path d="([^"]+)"/)?.[1];
    const render = (shapeSeed?: number) =>
      renderToString(
        <BotAvatar color="#D9508A" identity="maya" shapeSeed={shapeSeed} variant="organic" />,
      );

    expect(body(render(1))).toBeTruthy();
    expect(body(render(1))).not.toBe(body(render(2)));
    expect(body(render(1))).toBe(body(render(1 + SHAPES.length)));
    expect(body(render())).toBe(body(render(avatarIdentitySeed("maya") % SHAPES.length)));
  });

  it("uses the account avatar preference when no local variant is provided", () => {
    const html = renderToString(
      <AvatarStyleProvider value="organic">
        <BotAvatar color="#D9508A" identity="maya" />
      </AvatarStyleProvider>,
    );

    expect(html).toContain("rakazo-organic-avatar");
  });
});
