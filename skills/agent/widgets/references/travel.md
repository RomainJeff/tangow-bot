# Places and trips

## Structure

Use **hero, facts, days, places**. Let the app show the title; start with a `.media` hero,
then a `.row` of `.badge` facts, day `.tabs`, and place `.card`s in a `.grid`.
Keep one day visible. Link to OpenStreetMap outside the widget instead of embedding a map.

## Phone interactions

Use two to four day tabs with short labels and a card per stop. Keep map links
large enough to tap. Avoid hover, drag maps, five tabs, and horizontal carousels.

## Template: itinerary

Copy this example route. Title: `Two days near Nyhavn`. Its photo comes from the linked source.
```html
<main class="stack">
  <div class="grid">
  <figure class="media">
    <img src="https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/Nyhavn_Copenhagen_2.jpg/960px-Nyhavn_Copenhagen_2.jpg"
      alt="Boats along the canal beside Nyhavn's colorful waterfront buildings">
    <figcaption><a class="button secondary" href="https://commons.wikimedia.org/wiki/File:Nyhavn_Copenhagen_2.jpg">Photo: kallerna, CC BY-SA 4.0</a></figcaption>
  </figure>
  <div class="stack"><div class="row"><span class="badge">2 days</span><span class="badge">On foot</span></div>
  <div class="tabs" role="tablist" aria-label="Itinerary days">
    <button id="day-one" type="button" role="tab" aria-selected="true"
      aria-controls="one" tabindex="0">Day 1</button>
    <button id="day-two" type="button" role="tab" aria-selected="false"
      aria-controls="two" tabindex="-1">Day 2</button>
  </div>
  <section id="one" role="tabpanel" aria-labelledby="day-one" tabindex="0" class="grid">
    <article class="card stack">
      <h1>Canal walk</h1><p>Start beside the boats. Leave time to pause along the water.</p>
      <a class="button secondary" href="https://www.openstreetmap.org/relation/6476337">Nyhavn map</a>
    </article>
  </section>
  <section id="two" role="tabpanel" aria-labelledby="day-two" tabindex="0" class="grid" hidden>
    <article class="card stack">
      <h1>Waterfront details</h1><p>Return for a slower walk and look at the house fronts.</p>
      <a class="button secondary" href="https://www.openstreetmap.org/relation/6476337">Nyhavn map</a>
    </article>
  </section>
  </div></div>
</main>
<script>
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectDay(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = i !== index;
    });
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectDay(i));
    tab.addEventListener('keydown', event => {
      const indexes = {ArrowRight: (i + 1) % tabs.length,
        ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1};
      if (!(event.key in indexes)) return;
      event.preventDefault();
      selectDay(indexes[event.key]);
      tabs[indexes[event.key]].focus();
    });
  });
</script>
```

## Media

### Structure

Use **captioned gallery** for photos, **native player** for direct media,
**thumbnail link** for hosted video, and **paired figures** for before/after.
Copy one file below. Replace media only with URLs read from a real source.

### Phone interactions

Let `.grid` stack the figures. Use native media controls with no autoplay.
Keep a visible description or transcript for meaningful sound and speech.
YouTube and Vimeo open outside; no player iframe. For Vimeo, read a thumbnail URL
from a real source, never guess a thumbnail path. Avoid a drag comparison slider.

### Template: gallery

Suggested tool title: `Views along Nyhavn`.

```html
<main class="stack">
  <div class="grid">
    <figure class="media"><img loading="lazy" src="https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/Nyhavn_Copenhagen_2.jpg/960px-Nyhavn_Copenhagen_2.jpg"
      alt="Boats and colorful buildings beside Nyhavn canal">
      <figcaption><a class="button secondary" href="https://commons.wikimedia.org/wiki/File:Nyhavn_Copenhagen_2.jpg">Canal · kallerna · CC BY-SA 4.0</a></figcaption></figure>
    <figure class="media"><img loading="lazy" src="https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c0/Nyhavn_Copenhagen_3.jpg/960px-Nyhavn_Copenhagen_3.jpg"
      alt="A closer view of Nyhavn's waterfront house fronts">
      <figcaption><a class="button secondary" href="https://commons.wikimedia.org/wiki/File:Nyhavn_Copenhagen_3.jpg">Houses · kallerna · CC BY-SA 4.0</a></figcaption></figure>
  </div>
</main>
```

### Template: direct video

Title: `Watch Big Buck Bunny`. URLs are from [MDN's video example](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video#single_source).

```html
<main class="stack">
  <figure class="media">
    <video controls playsinline preload="metadata" aria-label="Big Buck Bunny film"
      poster="https://peach.blender.org/wp-content/uploads/title_anouncement.jpg?x11217"
      src="https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4"></video>
    <figcaption>Big Buck Bunny · Blender Foundation · CC BY 3.0</figcaption></figure>
  <a class="button secondary" href="https://archive.org/details/BigBuckBunny_124">Film and source details</a>
</main>
```

### Template: YouTube thumbnail link

Title: `Watch Big Buck Bunny`. The ID comes from the [official film page](https://www.youtube.com/watch?v=aqz-KE-bpKQ).
```html
<main class="stack">
  <figure class="media">
    <a href="https://www.youtube.com/watch?v=aqz-KE-bpKQ" aria-label="Watch Big Buck Bunny on YouTube">
      <img src="https://img.youtube.com/vi/aqz-KE-bpKQ/hqdefault.jpg" alt="Big Buck Bunny film thumbnail"></a>
    <figcaption>Opens on YouTube · Blender Foundation</figcaption></figure>
</main>
```

### Template: before/after

Title: `Before and after sorting`. Use two captioned figures. For photos, use sourced images with `alt`.

```html
<main class="stack">
  <div class="grid">
    <figure class="card stack"><figcaption>Before: unsorted values</figcaption><p>8, 2, 5</p></figure>
    <figure class="card stack"><figcaption>After: ascending values</figcaption><p>2, 5, 8</p></figure>
  </div>
</main>
```

## Pitfalls

- Never guess an image URL, fabricate opening hours, or use a map embed.
- Preserve credits and license links when using the sample photos. Replace them with the new source's credits when changing images.
- Do not turn a still photo into a claim about current conditions or a true before/after pair.
- Do not autoplay media, hide playback behind hover, or place all days in one tall list.
- Do not download external images just to encode them as `data:`. Keep HTTPS URLs.
