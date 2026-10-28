# Explanation

## Structure

Choose **step sequence** for a process, or **topic tabs** for independent views.
Start with controls and one visible panel; the app shows the widget title. Keep each panel below
80 words and use at most one visual. Change the example, preserve the layout.

## Phone interactions

Use Previous/Next buttons for ordered steps. Disable the button at each end.
Use two to four tabs with short labels for independent topics. Support keyboard
arrows, Home, and End as well as taps. Use `hidden` for inactive panels and update
`aria-selected` with them. Keep controls above the panel and long content in steps.
Avoid a fifth tab, hover explanations, drag gestures, and scroll-driven animation.

## Template: step sequence

Copy this entire body-only file. Suggested tool title: `How a queue works`.
The diagram is optional; use visible text for every fact it conveys.

```html
<main class="stack">
  <div class="row" aria-label="Step controls">
    <button class="button secondary" id="previous" type="button" disabled>Previous</button>
    <span id="progress" class="muted" role="status">Step 1 of 3</span>
    <button class="button" id="next" type="button">Next</button>
  </div>
  <div id="steps">
    <section class="card stack" aria-labelledby="add">
      <h1 id="add">1. Add a job</h1>
      <p>A request joins the back of the queue. Older jobs stay ahead of it.</p>
      <svg width="280" height="72" viewBox="0 0 280 72" role="img" aria-labelledby="queue-title"
        style="max-width:100%;fill:currentColor;font-size:13px">
        <title id="queue-title">Job A is first, then B, then C</title>
        <rect x="4" y="8" width="72" height="56" fill="none" stroke="currentColor"/>
        <rect x="104" y="8" width="72" height="56" fill="none" stroke="currentColor"/>
        <rect x="204" y="8" width="72" height="56" fill="none" stroke="currentColor"/>
        <text x="40" y="42" text-anchor="middle">A</text>
        <text x="140" y="42" text-anchor="middle">B</text>
        <text x="240" y="42" text-anchor="middle">C</text>
      </svg>
    </section>
    <section class="card stack" aria-labelledby="take" hidden>
      <h1 id="take">2. Take the oldest</h1>
      <p>A worker takes job A from the front. B and C keep their order.</p>
    </section>
    <section class="card stack" aria-labelledby="finish" hidden>
      <h1 id="finish">3. Finish the job</h1>
      <p>The worker records the result, then takes B. The queue absorbs bursts
        while the worker handles one job at a time.</p>
    </section>
  </div>
</main>
<script>
  const steps = [...document.querySelectorAll('#steps > section')];
  const previous = document.getElementById('previous');
  const next = document.getElementById('next');
  let current = 0;
  function showStep(index) {
    current = Math.max(0, Math.min(index, steps.length - 1));
    steps.forEach((panel, i) => { panel.hidden = i !== current; });
    previous.disabled = current === 0;
    next.disabled = current === steps.length - 1;
    document.getElementById('progress').textContent = `Step ${current + 1} of ${steps.length}`;
    if (document.activeElement.disabled) (current === 0 ? next : previous).focus();
  }
  previous.addEventListener('click', () => showStep(current - 1));
  next.addEventListener('click', () => showStep(current + 1));
</script>
```

## Template: topic tabs

Copy this entire file for views that can be read in any order.
Suggested tool title: `Understand a queue system`.

```html
<main class="stack">
  <div class="tabs" role="tablist" aria-label="Queue topics">
    <button type="button" id="input-tab" role="tab" aria-selected="true"
      aria-controls="input-panel" tabindex="0">Input</button>
    <button type="button" id="work-tab" role="tab" aria-selected="false"
      aria-controls="work-panel" tabindex="-1">Work</button>
  </div>
  <section class="card stack" id="input-panel" role="tabpanel"
    aria-labelledby="input-tab" tabindex="0">
    <h1>Collect requests</h1>
    <p>A queue holds jobs until a worker can take them. A burst of requests
      can wait here without starting every job at once.</p>
  </section>
  <section class="card stack" id="work-panel" role="tabpanel"
    aria-labelledby="work-tab" tabindex="0" hidden>
    <h1>Process requests</h1>
    <p>A worker takes the oldest waiting job and records its result.
      The next job can then begin.</p>
  </section>
</main>
<script>
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = i !== index;
    });
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(i));
    tab.addEventListener('keydown', event => {
      const indexes = {ArrowRight: (i + 1) % tabs.length,
        ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1};
      if (!(event.key in indexes)) return;
      event.preventDefault();
      const index = indexes[event.key];
      selectTab(index);
      tabs[index].focus();
    });
  });
</script>
```

## Template: flow diagram

Title: `How a refund is processed`. Use for a process, a pipeline or "what happens
when". Keep 3 to 6 nodes, top to bottom so it reads on a phone. Each node gets a
bold name and one short muted line; arrow labels are one or two words. Add 112 to
every `y` per extra node and grow `viewBox` and `height` by the same amount.
Outline only the node that matters most (here the outcome) in `currentColor`.

```html
<div class="stack">
  <h2>How a refund is processed</h2>
  <svg viewBox="0 0 320 400" height="400" width="100%" role="img" aria-labelledby="flow-title">
    <title id="flow-title">You ask, support checks the order, the bank is credited, you are notified.</title>
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
      </marker>
    </defs>
    <g fill="none" stroke="var(--border)" stroke-width="1.5">
      <rect x="40" y="8" width="240" height="64" rx="12" />
      <rect x="40" y="120" width="240" height="64" rx="12" />
      <rect x="40" y="232" width="240" height="64" rx="12" />
      <rect x="40" y="328" width="240" height="64" rx="12" stroke="currentColor" />
    </g>
    <g stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)">
      <line x1="160" y1="72" x2="160" y2="116" />
      <line x1="160" y1="184" x2="160" y2="228" />
      <line x1="160" y1="296" x2="160" y2="324" />
    </g>
    <g fill="currentColor" text-anchor="middle" font-size="15" font-weight="600">
      <text x="160" y="36">Request</text>
      <text x="160" y="148">Order check</text>
      <text x="160" y="260">Bank transfer</text>
      <text x="160" y="356">Refunded</text>
    </g>
    <g fill="var(--muted-foreground)" text-anchor="middle" font-size="13">
      <text x="160" y="56">from your order page</text>
      <text x="160" y="168">support confirms the item</text>
      <text x="160" y="280">sent to your card</text>
      <text x="160" y="376">email when it lands</text>
    </g>
    <g fill="var(--muted-foreground)" font-size="12">
      <text x="172" y="100">within 24 h</text>
      <text x="172" y="212">approved</text>
    </g>
  </svg>
  <dl>
    <dt>Usual delay</dt><dd>3 to 5 business days</dd>
    <dt>Not refundable</dt><dd>gift cards, opened software</dd>
  </dl>
</div>
```

For a cycle or a branch, keep the same boxes and draw the extra arrow as a
`path` along the right side (`x` around 300); never cross text. More than six
nodes or several branches: split into steps instead.

## Pitfalls

- Do not hide the only explanation inside an SVG or an unnamed icon.
- Keep tab labels short enough to fit at 360px. Split long material into steps.
- Do not render every step at once or append a second diagram below the first.
- Never write node text smaller than 12px or let it overflow its box; shorten the words instead.
- Keep IDs unique when adapting a template. Each `aria-controls` names a real panel.
- Do not auto-advance. A user must be able to read a panel without a timer.
- Any reload can reset the panel. Do not make a selection a saved answer or build input-heavy forms.
