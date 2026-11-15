import { avatarIdentitySeed, SHAPES } from "@tangow/core";
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

  it.each([
    ["running", "true"],
    ["queued", "true"],
    ["leased", "true"],
    ["waiting_input", "false"],
    ["waiting_takeover", "false"],
  ])("draws a %s bot as working: %s", (status, working) => {
    for (const variant of ["robot", "organic"] as const) {
      const html = renderToString(
        <BotAvatar color="#3B82F6" identity="maya" status={status} variant={variant} />,
      );
      expect(html).toContain(`data-working="${working}"`);
    }
    const clay = renderToString(<BotAvatar color="#3B82F6" character="atlas" status={status} />);
    expect(clay).toContain(`data-working="${working}"`);
  });

  it("keeps the working ring mounted when idle so its timeline does not reset", () => {
    const html = renderToString(<BotAvatar color="#F59E0B" status="idle" variant="robot" />);
    expect(html).toContain('data-working="false"');
    expect(html).toContain("tangow-bot-avatar-ring");
  });

  it("defaults to the organic avatar when no style preference is provided", () => {
    const html = renderToString(<BotAvatar color="#D9508A" identity="maya" status="running" />);
    expect(html).toContain("tangow-organic-avatar");
    expect(html).not.toContain("tangow-bot-avatar-ring");
  });

  it("draws the organic avatar with the bloub engine", () => {
    const html = renderToString(
      <BotAvatar color="#D9508A" identity="maya" size={28} status="running" variant="organic" />,
    );

    expect(html).toContain("tangow-organic-avatar");
    expect(html).toContain('data-working="true"');
    expect(html).toContain("<clipPath");
    expect(html).not.toContain("tangow-bot-avatar-visor");
  });

  it("paints two eyes over an idle body", () => {
    const html = renderToString(<BotAvatar color="#00C46A" identity="maya" variant="organic" />);
    const body = html.match(/<clipPath[^>]*><path d="([^"]+)"/)?.[1];
    const eyes = html.match(/<g clip-path="url\([^"]+\)" fill="#101014">(.*?)<\/g>/)?.[1];

    expect(html).toContain('data-working="false"');
    expect(eyes?.match(/<path /g)).toHaveLength(2);
    expect(html).toContain('fill="#00C46A"');
    // A mid-luminance hue keeps ink eyes and no body outline. The ink is only on the
    // eyes: a backing under the whole body bleeds through its edge as a dark fringe.
    expect(html).toContain(`<path d="${body}" fill="#00C46A"`);
    expect(html).not.toContain(`<path d="${body}" fill="#101014"`);
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
    const body = (html: string) => html.match(/<clipPath[^>]*><path d="([^"]+)"/)?.[1];
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

    expect(html).toContain("tangow-organic-avatar");
  });
});
