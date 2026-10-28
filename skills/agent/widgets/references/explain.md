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
        style="max-width:100%;fill:currentColor;font-size:var(--type-body-size)">
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

## Pitfalls

- Do not hide the only explanation inside an SVG or an unnamed icon.
- Keep tab labels short enough to fit at 360px. Split long material into steps.
- Do not render every step at once or append a second diagram below the first.
- Keep IDs unique when adapting a template. Each `aria-controls` names a real panel.
- Do not auto-advance. A user must be able to read a panel without a timer.
- Any reload can reset the panel. Do not make a selection a saved answer or build input-heavy forms.
