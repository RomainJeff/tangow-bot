import { matchFeaturedConnectorId } from "./featured-connectors.js";

/** The apps whose mark ships with the product: no runtime fetch, the same drawing on every surface. */
export type AppMarkId = "gmail" | "outlook" | "slack";

/** One filled or stroked path of a mark, drawn in its own colours on any background. */
export type AppMarkShape = {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
};

export type AppMark = {
  viewBox: string;
  shapes: readonly AppMarkShape[];
};

export const APP_MARKS: Record<AppMarkId, AppMark> = {
  gmail: {
    viewBox: "52 42 88 66",
    shapes: [
      { fill: "#4285f4", d: "M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" },
      { fill: "#34a853", d: "M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" },
      { fill: "#fbbc04", d: "M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" },
      { fill: "#ea4335", d: "M72 74V48l24 18 24-18v26L96 92" },
      { fill: "#c5221f", d: "M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" },
    ],
  },
  slack: {
    viewBox: "0 0 127 127",
    shapes: [
      {
        fill: "#e01e5a",
        d: "M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z",
      },
      {
        fill: "#36c5f0",
        d: "M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z",
      },
      {
        fill: "#2eb67d",
        d: "M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z",
      },
      {
        fill: "#ecb22e",
        d: "M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z",
      },
    ],
  },
  // A simplified drawing of the current Outlook mark (a blue O tile over an envelope), not
  // Microsoft's official asset: swap in the official artwork when it is licensed for the product.
  outlook: {
    viewBox: "0 0 32 32",
    shapes: [
      {
        fill: "#0364b8",
        d: "M13.5 5h14a2.5 2.5 0 0 1 2.5 2.5v17a2.5 2.5 0 0 1-2.5 2.5h-14a2.5 2.5 0 0 1-2.5-2.5v-17A2.5 2.5 0 0 1 13.5 5z",
      },
      { fill: "#28a8ea", d: "M11 13.5h19V24.5a2.5 2.5 0 0 1-2.5 2.5h-14A2.5 2.5 0 0 1 11 24.5z" },
      { stroke: "#0078d4", strokeWidth: 1.6, d: "M11 13.5l9.5 6.5 9.5-6.5" },
      {
        fill: "#0078d4",
        d: "M5 8h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z",
      },
      {
        stroke: "#ffffff",
        strokeWidth: 2.2,
        d: "M6.1 16a3.9 4.5 0 1 0 7.8 0 3.9 4.5 0 1 0-7.8 0z",
      },
    ],
  },
};

/** Which bundled mark an app name asks for: the featured connectors' aliases, plus Outlook. */
export function appMarkId(appName: string): AppMarkId | null {
  const featured = matchFeaturedConnectorId(appName);
  if (featured === "gmail" || featured === "slack") return featured;
  return /outlook/i.test(appName) ? "outlook" : null;
}

/** What stands for an app in a card: its catalog logo, else a bundled mark, else a neutral glyph. */
export type AppIcon =
  | { kind: "logo"; uri: string }
  | { kind: "mark"; mark: AppMark }
  | { kind: "glyph"; glyph: "mail" | "message" };

export function appIcon(app: { name: string; logo: string | null }, chat: boolean): AppIcon {
  if (app.logo) return { kind: "logo", uri: app.logo };
  const id = appMarkId(app.name);
  if (id) return { kind: "mark", mark: APP_MARKS[id] };
  return { kind: "glyph", glyph: chat ? "message" : "mail" };
}
