---
name: Widgets
description: Show an interactive view with show_widget when visualizing data, explaining visually, comparing options, planning itineraries, or presenting media helps. Use text for answers that need only a paragraph.
---

# Widgets

## 1. Choose a view only when it helps

Use a widget when seeing or manipulating content helps; otherwise answer in text.
Publish one widget per response without repeating its content in the message.
The model cannot see the render; copy a template and change its content.

## 2. Apply these seven rules

1. Design at 360px, then widen. Use one column by default and `.grid` for cards that
   may sit side by side. Never require hover or dragging. Make tap targets at least
   44px in both dimensions. Keep the widget compact; put long content behind
   tabs or steps. Users can open it full screen. Avoid nested scroll and viewport
   units: never use vh/dvh/svh/lvh or `height:100%` on html/body or the outermost
   element. The frame fits its content; those heights make it grow forever. Give
   charts a fixed pixel height, such as an SVG `height="244"` with a `viewBox`.
2. Use only kit classes and `var(--…)` design tokens. Never add hex or rgb colors,
   gradients, shadows, or fonts. Keep the UI monochrome; photos bring color.
   Reserve `--destructive`, `--success`, and `--warning` for named status meanings.
   Use only 4/8/12/16/24px spacing. Never set a background on html/body or the
   outermost element. The app supplies the frame and title; add no outer card,
   border, or title banner. Inner content boxes use `.card` with 16px padding
   and `--corner-card`. Read `references/kit.md` before adding styles.
3. Make no network calls. No `fetch`, XHR, WebSocket, CDN, external script,
   stylesheet, font, nested iframe, or embed. Images, video, and audio may use
   HTTPS URLs. Turn YouTube/Vimeo into thumbnail links, never embedded players.
   For YouTube use `https://img.youtube.com/vi/<id>/hqdefault.jpg` with a verified
   video ID. Never invent image URLs; copy them from a real search result, page,
   or tool result. Prefer handwritten SVG/JS. An inline library is allowed only
   when that cannot do the job. Read and paste it from a file actually on the
   computer; never retype it from memory. It costs hundreds of KB and many tokens; transcription breaks it.
4. Produce one file, at most 2 MB in UTF-8 bytes. Write only body content,
   with inline styles/scripts if needed. Rakazo adds document, viewport, CSP,
   theme tokens, and kit. Omit doctype, html, head, and body tags.
   Use HTTPS media URLs. Use `data:` images only for images produced on the
   computer, compressed first. Do not inline audio or video.
5. Link to HTTPS pages outside the widget. Use real `<a href="https://…">` links;
   Rakazo opens them externally. Do not navigate the frame or submit forms.
6. Give every image descriptive `alt`, every control a name, and every SVG an
   accessible title. Use real buttons for actions, ordered heading levels, and
   visible labels for values. Keep interactions local; there is no channel to the bot.
7. Give `show_widget` a title of 3-6 words naming the subject. It is the accessible
   name and the `[widget: title]` placeholder outside the app.

## 3. Read one case reference

Copy its template, replace the content, and keep its structure. Read `kit.md` only to depart from it.

| Case | Signal | Read |
| --- | --- | --- |
| Explanation | Concept, process, how it works, steps | [explain.md](references/explain.md) |
| Data | Numbers, series, an explorable table, KPIs | [data.md](references/data.md) |
| Comparison | Choosing between options | [data.md, Comparison](references/data.md#comparison) |
| Place & trip | Destination, itinerary, days | [travel.md](references/travel.md) |
| Media | Gallery, video, before/after | [travel.md, Media](references/travel.md#media) |
| Other | No case fits | [kit.md](references/kit.md), then the closest case |

## 4. Publish and refine

Call `show_widget` with `title` and exactly one of `html` or `path`.
Pass short body content as `html`, or write one HTML file on the bot computer and pass its absolute `path`.
To refine a widget, write the revised file on the computer and call `show_widget`
again with `path`. Each call publishes a new widget; it does not edit the old one.
State only what the widget does not show. It may reload at any time, including
when scrolled away, when the theme changes, or in full screen. Local state is not
kept. Do not build input-heavy forms or promise persistence.

## 5. Read the code before calling

- At 360px: one column, short labels, 44px controls, compact tabs or steps, fixed
  pixel chart heights, no viewport units or outer 100% height, and no hover or drag.
- Tokens: only kit classes, allowed tokens, spacing steps, and `currentColor` SVG;
  no colors, fonts, gradients, shadows, outer background, frame, or title banner.
- Network: no requests except sourced HTTPS media; links are HTTPS; no embeds,
  external code, form submits, or fabricated image URLs. Check the UTF-8 byte size.

Expected result: one readable widget in the thread and full screen on web, desktop, and phone.
