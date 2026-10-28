# Data

## Structure

Use **numbers, chart, detail**. Put one or two KPIs first, then one inline SVG
chart, then a compact sortable table. Label the period and units in visible text.
Use real input values; the template below contains fictional demonstration data.
For choosing between options, use the [Comparison](#comparison) structure instead.

## Phone interactions

Use a button in a table heading to sort. Update `aria-sort` and announce the order.
Keep at most three short columns. Use cards for long descriptions or extra fields.
Show values beside marks. Never make a tooltip, hover, pan, or zoom necessary.
Distinguish series with `currentColor` opacity and label them in words.

## Template: KPIs, bars, sortable table

Copy this entire body-only file. Suggested tool title: `Regional sales in March`.
The SVG and table use the same values. Keep both in sync when replacing the data.

```html
<main class="stack">
  <p class="muted">March 2026 · Units sold · Example data</p>
  <div class="grid">
    <div class="card stat"><div class="value">740</div><div class="label">March units</div></div>
    <div class="card stat"><div class="value">+5.7%</div><div class="label">Since February</div></div>
  </div>
  <div class="grid">
  <section class="stack" aria-labelledby="chart-heading">
    <h1 id="chart-heading">By region</h1>
    <p class="muted">Paired bars: March solid, February lighter. Values are units.</p>
    <svg width="320" height="244" viewBox="0 0 320 244" role="img" aria-labelledby="sales-title sales-desc"
      style="max-width:100%;fill:currentColor;font-size:13px">
      <title id="sales-title">March and February sales by region</title>
      <desc id="sales-desc">North 320 and 280. South 240 and 220. West 180 and 200 units.</desc>
      <text x="0" y="20">North</text>
      <rect x="0" y="28" width="256" height="16"/>
      <text x="264" y="42">320</text>
      <rect x="0" y="48" width="224" height="16" opacity="0.45"/>
      <text x="232" y="62">280</text>
      <text x="0" y="100">South</text>
      <rect x="0" y="108" width="192" height="16"/>
      <text x="200" y="122">240</text>
      <rect x="0" y="128" width="176" height="16" opacity="0.45"/>
      <text x="184" y="142">220</text>
      <text x="0" y="180">West</text>
      <rect x="0" y="188" width="144" height="16"/>
      <text x="152" y="202">180</text>
      <rect x="0" y="208" width="160" height="16" opacity="0.45"/>
      <text x="168" y="222">200</text>
    </svg>
  </section>
  <div class="stack">
  <table>
    <caption>Units sold by region</caption>
    <thead><tr>
      <th scope="col">Region</th>
      <th scope="col" aria-sort="none"><button type="button" class="button secondary"
        id="sort">March</button></th>
      <th scope="col">February</th>
    </tr></thead>
    <tbody id="regions">
      <tr><th scope="row">North</th><td>320</td><td>280</td></tr>
      <tr><th scope="row">South</th><td>240</td><td>220</td></tr>
      <tr><th scope="row">West</th><td>180</td><td>200</td></tr>
    </tbody>
  </table>
  <small class="muted" id="sort-status" role="status">Tap March to sort.</small>
  </div>
  </div>
</main>
<script>
  const sort = document.getElementById('sort');
  const body = document.getElementById('regions');
  let ascending = false;
  sort.addEventListener('click', () => {
    ascending = !ascending;
    const rows = [...body.rows].sort((a, b) => {
      const difference = Number(a.cells[1].textContent) - Number(b.cells[1].textContent);
      return ascending ? difference : -difference;
    });
    body.append(...rows);
    const order = ascending ? 'ascending' : 'descending';
    sort.parentElement.setAttribute('aria-sort', order);
    document.getElementById('sort-status').textContent = `March units, ${order}.`;
  });
</script>
```

## Comparison

### Structure

Use **parallel option cards**. Put two to four `.card`s in a `.grid`.
Use the same headings and field order for every option. Put the decisive tradeoff
first, then the facts that support it. Show a recommendation only with a reason.
No interaction is needed when reading the options side by side is enough.

### Phone interactions

Cards stack on a phone. Keep each option self-contained so the user need not
remember a column heading. Use external `.button` links only for sourced actions.
Avoid a wide comparison table, a carousel, and a badge that declares a winner
without explaining the criterion. Do not rely on color to mark a preferred option.

### Template: option cards

Copy this entire file. Suggested tool title: `Choose a backup schedule`.

```html
<main class="stack">
  <p>Choose hourly when losing a day's edits would be costly.</p>
  <div class="grid">
    <section class="card stack" aria-labelledby="daily">
      <h1 id="daily">Daily</h1>
      <p class="muted">For files that change infrequently.</p>
      <dl>
        <dt>Possible lost work</dt><dd>Up to 24 hours</dd>
        <dt>Runs per day</dt><dd>1</dd>
        <dt>Tradeoff</dt><dd>Fewer runs, longer recovery gap</dd>
      </dl>
    </section>
    <section class="card stack" aria-labelledby="hourly">
      <h1 id="hourly">Hourly</h1>
      <p class="muted">For files edited throughout the day.</p>
      <dl>
        <dt>Possible lost work</dt><dd>Up to 1 hour</dd>
        <dt>Runs per day</dt><dd>24</dd>
        <dt>Tradeoff</dt><dd>More runs, shorter recovery gap</dd>
      </dl>
    </section>
  </div>
</main>
```

## Pitfalls

- Cap charts at two series. Extra series make opacity differences hard to read.
- Start bar lengths at zero and share the same scale for every series and region.
- Reserve room for the largest value label. Do not put text inside narrow bars.
- Remove fields before shrinking a table. Never add a horizontal scroll container.
- Give missing data a visible label; never convert it to a zero or invent a KPI.
- Keep the chart's labels and accessible description consistent with the table.
