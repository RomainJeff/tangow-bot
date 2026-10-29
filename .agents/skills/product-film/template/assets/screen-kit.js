// The screen kit: iOS-style building blocks in HTML on the app's tokens (screen-kit.css). 402 × 874 CSS px, like an
// iPhone Pro screen. A screen exposes data-part hooks the film's timeline animates. The Dynamic Island is drawn by the
// phone, not by the screen. Build your product's screens from these parts (or replace them with your own markup).
(function () {
  const P = {
    cl: '<path d="m15 18-6-6 6-6"/>', cr: '<path d="m9 18 6-6-6-6"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  };
  const ic = (n, s = 16) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${+((24 * (s <= 16 ? 1.33 : 1.5)) / s).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

  const statusBar = (time) => `<div data-part="status" class="ab" style="left:0;right:0;top:0;height:54px;z-index:5;color:var(--ink)">
    <span class="ab" style="left:52px;top:17px;font-size:17px;font-weight:600;letter-spacing:-.02em">${time}</span>
    <span class="ab" style="right:30px;top:21px;display:flex;gap:6px;align-items:center">
      <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>
      <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0zM3.4 6.9a6.5 6.5 0 0 1 9.2 0l-1.4 1.4a4.5 4.5 0 0 0-6.4 0zM1.2 4.6a9.6 9.6 0 0 1 13.6 0l-1.4 1.4a7.6 7.6 0 0 0-10.8 0z" fill="currentColor"/></svg>
      <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2.5" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".45"/></svg></span></div>`;
  const pEdge = `<div class="edge" style="left:0;right:0;top:0;height:124px;background:linear-gradient(to bottom,rgba(var(--edge),.92),rgba(var(--edge),.7) 55%,rgba(var(--edge),0));-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);-webkit-mask-image:linear-gradient(to bottom,#000 60%,transparent);mask-image:linear-gradient(to bottom,#000 60%,transparent);z-index:2"></div>`;
  const gCircle = (n, s = 44) => `<span class="glass-ctl ib" style="width:${s}px;height:${s}px;border-radius:${s / 2}px">${ic(n, s > 40 ? 20 : 18)}</span>`;
  const homeInd = `<span data-part="home" class="ab" style="left:50%;bottom:8px;width:139px;height:5px;margin-left:-69.5px;border-radius:3px;background:var(--ink);z-index:6"></span>`;
  const bb = (html, extra = "") => `<div class="bb" style="font-size:17px;line-height:22px;padding:11px 16px;${extra}">${html}</div>`;
  const ub = (html) => `<div class="ub" style="font-size:17px;line-height:22px;padding:11px 16px">${html}</div>`;
  const ln = (icon, html, extra = "") => `<div class="ln" style="padding-left:16px;font-size:14px;line-height:20px;${extra}">${icon ? ic(icon, 14) : ""}${html}</div>`;
  const opt = (title, desc) => `<div class="opt" style="font-size:17px;line-height:22px"><div style="flex:1"><div>${title}</div>${desc ? `<div class="dd" style="font-size:15px;line-height:20px">${desc}</div>` : ""}</div></div>`;
  // The product's working line: avatar (26 px), label in muted-foreground, a running elapsed counter.
  const wl = (labels, extra = "") => `<div data-part="wl" style="display:flex;align-items:center;gap:14px;padding-left:2px;overflow:hidden;${extra}">
      <svg data-part="wl-av" width="26" height="26" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;flex:none"></svg>
      <span style="position:relative;font-size:15px;line-height:20px;letter-spacing:-.01em;color:var(--sub);white-space:nowrap">${labels.map((l, i) => `<span data-part="wl-l${i}" style="${i ? "position:absolute;left:0;top:0;opacity:0" : ""}">${l}</span>`).join("")}</span>
      <span data-part="wl-time" style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:18px;color:var(--sub);font-variant-numeric:tabular-nums">0.0s</span></div>`;
  const otherOpt = `<div class="opt" style="font-size:17px;line-height:22px;color:var(--sub);font-weight:400"><span style="flex:1">Other answer…</span>${ic("pencil", 18)}</div>`;

  // A screen: ambient, scrolling thread (bottom-aligned), scroll edge, status bar, header, composer.
  function screen({ theme, time, title = "Assistant", thread, composer = "Message", id, overlay = "" }) {
    const el = document.createElement("div");
    el.className = "scr";
    el.dataset.theme = theme;
    if (id) el.id = id;
    el.style.cssText = "position:absolute;left:0;top:0;width:402px;height:874px;overflow:hidden";
    el.innerHTML = `<div data-part="amb" class="amb-p"></div>
      <div class="ab" style="left:0;right:0;top:0;bottom:0;padding:112px 16px 100px;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,transparent 0,transparent 60px,#000 124px,#000 calc(100% - 100px),transparent calc(100% - 28px));mask-image:linear-gradient(to bottom,transparent 0,transparent 60px,#000 124px,#000 calc(100% - 100px),transparent calc(100% - 28px))">
        <div data-part="thread" style="display:flex;flex-direction:column;gap:12px;justify-content:flex-end;height:100%">${thread}</div></div>
      ${pEdge}${statusBar(time)}
      <div data-part="header" class="ab" style="left:16px;right:16px;top:58px;display:flex;align-items:center;z-index:3">${gCircle("cl")}<span style="flex:1;display:flex;justify-content:center;align-items:center;gap:8px;font-size:17px;font-weight:600;letter-spacing:-.02em"><svg data-part="header-avatar" width="28" height="28" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;opacity:var(--hav-op,1)"></svg><span data-part="header-title" style="opacity:var(--title-op,1)">${title}</span></span>${gCircle("phone")}</div>
      ${overlay}
      <div data-part="composer-row" class="ab" style="left:16px;right:16px;bottom:34px;display:flex;gap:8px;z-index:3">${gCircle("plus", 48)}<span class="glass-ctl" style="flex:1;height:48px;border-radius:24px;display:flex;align-items:center;padding:0 16px;font-size:17px;color:var(--sub)"><span data-part="composer" style="flex:1;position:relative">${composer}</span>${ic("mic", 20)}</span></div>${homeInd}`;
    return el;
  }


  window.ScreenKit = { screen, ic, bb, ub, ln, opt, wl, otherOpt, gCircle };
})();
