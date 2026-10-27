/**
 * A small static travel agency site for browser benchmarks. It is served from the computer under
 * test, so no external site is involved. Every page renders from `CIRCUITS`.
 */
export const TRAVEL_SITE_PORT = 8765;
export const TRAVEL_SITE_URL = `http://127.0.0.1:${TRAVEL_SITE_PORT}/`;

type Departure = { date: string; label: string; perPerson: number };
export type Circuit = {
  slug: string;
  name: string;
  destination: "Japan" | "Vietnam" | "Thailand" | "Peru";
  days: number;
  cities: string[];
  departures: Departure[];
  bookingFee: number;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const on = (date: string, perPerson: number): Departure => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { date, label: `${day} ${MONTHS[month - 1]} ${year}`, perPerson };
};

/** In the site's "recommended" order, which is not the price order. */
export const CIRCUITS: readonly Circuit[] = [
  {
    slug: "essential-japan",
    name: "Essential Japan",
    destination: "Japan",
    days: 12,
    cities: ["Tokyo", "Hakone", "Kyoto", "Nara", "Osaka"],
    departures: [on("2027-04-06", 2290), on("2027-05-11", 2350)],
    bookingFee: 90,
  },
  {
    slug: "classic-vietnam",
    name: "Classic Vietnam North to South",
    destination: "Vietnam",
    days: 15,
    cities: ["Hanoi", "Ha Long Bay", "Hue", "Hoi An", "Ho Chi Minh City"],
    departures: [on("2027-03-02", 1890), on("2027-10-05", 1950)],
    bookingFee: 70,
  },
  {
    slug: "peace-and-temples",
    name: "Peace and Temples",
    destination: "Japan",
    days: 10,
    cities: ["Osaka", "Kyoto", "Okayama", "Hiroshima", "Miyajima"],
    departures: [on("2027-04-20", 2880), on("2027-05-18", 2450)],
    bookingFee: 110,
  },
  {
    slug: "thai-islands-escape",
    name: "Thai Islands Escape",
    destination: "Thailand",
    days: 10,
    cities: ["Bangkok", "Krabi", "Koh Phi Phi", "Koh Lanta"],
    departures: [on("2027-04-10", 1690), on("2027-05-08", 1540), on("2027-06-12", 1480)],
    bookingFee: 80,
  },
  {
    slug: "japan-grand-tour",
    name: "Japan Grand Tour",
    destination: "Japan",
    days: 14,
    cities: ["Tokyo", "Takayama", "Kanazawa", "Kyoto", "Hiroshima", "Osaka"],
    departures: [on("2027-04-13", 3480), on("2027-05-04", 3300)],
    bookingFee: 150,
  },
  {
    slug: "mekong-delta-and-saigon",
    name: "Mekong Delta and Saigon",
    destination: "Vietnam",
    days: 8,
    cities: ["Ho Chi Minh City", "Cu Chi", "Ben Tre", "Can Tho", "Chau Doc"],
    departures: [on("2027-02-09", 1290), on("2027-11-16", 1340)],
    bookingFee: 60,
  },
  {
    slug: "cherry-blossom-trail",
    name: "Cherry Blossom Trail",
    destination: "Japan",
    days: 11,
    cities: ["Tokyo", "Kyoto", "Hiroshima", "Miyajima", "Osaka"],
    departures: [on("2027-03-20", 2150), on("2027-03-27", 2190)],
    bookingFee: 90,
  },
  {
    slug: "alps-and-old-towns",
    name: "Alps and Old Towns",
    destination: "Japan",
    days: 12,
    cities: ["Tokyo", "Matsumoto", "Takayama", "Shirakawa-go", "Kanazawa", "Kyoto"],
    departures: [on("2027-04-08", 2600), on("2027-09-14", 2650)],
    bookingFee: 100,
  },
  {
    slug: "northern-mountains-trek",
    name: "Northern Mountains Trek",
    destination: "Vietnam",
    days: 10,
    cities: ["Hanoi", "Mai Chau", "Sapa", "Ha Giang"],
    departures: [on("2027-04-03", 1450), on("2027-10-12", 1490)],
    bookingFee: 60,
  },
  {
    slug: "short-japan-sampler",
    name: "Short Japan Sampler",
    destination: "Japan",
    days: 8,
    cities: ["Tokyo", "Kyoto", "Hiroshima"],
    departures: [on("2027-04-15", 1990)],
    bookingFee: 80,
  },
  {
    slug: "rising-sun-discovery",
    name: "Rising Sun Discovery",
    destination: "Japan",
    days: 13,
    cities: ["Tokyo", "Nikko", "Kyoto", "Hiroshima", "Miyajima", "Osaka"],
    departures: [on("2027-04-14", 2740), on("2027-06-09", 2590)],
    bookingFee: 120,
  },
  {
    slug: "inca-trail-and-lima",
    name: "Inca Trail and Lima",
    destination: "Peru",
    days: 11,
    cities: ["Lima", "Cusco", "Sacred Valley", "Machu Picchu"],
    departures: [on("2027-05-02", 2390), on("2027-07-04", 2490)],
    bookingFee: 90,
  },
  {
    slug: "southern-islands-japan",
    name: "Southern Islands Japan",
    destination: "Japan",
    days: 12,
    cities: ["Fukuoka", "Nagasaki", "Kagoshima", "Yakushima"],
    departures: [on("2027-04-22", 2400)],
    bookingFee: 90,
  },
  {
    slug: "vietnam-highlights",
    name: "Vietnam Highlights",
    destination: "Vietnam",
    days: 9,
    cities: ["Hanoi", "Ha Long Bay", "Hoi An", "Ho Chi Minh City"],
    departures: [on("2027-03-16", 1590), on("2027-04-20", 1650)],
    bookingFee: 70,
  },
  {
    slug: "japan-in-depth",
    name: "Japan in Depth",
    destination: "Japan",
    days: 16,
    cities: ["Tokyo", "Nikko", "Kyoto", "Hiroshima", "Fukuoka"],
    departures: [on("2027-04-05", 3100)],
    bookingFee: 150,
  },
  {
    slug: "central-coast-escape",
    name: "Central Coast Escape",
    destination: "Vietnam",
    days: 7,
    cities: ["Da Nang", "Hoi An", "Hue"],
    departures: [on("2027-04-11", 990)],
    bookingFee: 50,
  },
  {
    slug: "hokkaido-snow-and-onsen",
    name: "Hokkaido Snow and Onsen",
    destination: "Japan",
    days: 9,
    cities: ["Sapporo", "Otaru", "Niseko", "Noboribetsu"],
    departures: [on("2027-02-02", 2190)],
    bookingFee: 90,
  },
  {
    slug: "northern-thailand-temples",
    name: "Northern Thailand Temples",
    destination: "Thailand",
    days: 9,
    cities: ["Bangkok", "Ayutthaya", "Sukhothai", "Chiang Mai", "Chiang Rai"],
    departures: [on("2027-01-12", 1390), on("2027-11-09", 1420)],
    bookingFee: 70,
  },
];

/** Thousands grouped by a plain space, as the site prints prices: 5600 is "5 600". */
export const price = (amount: number) => String(amount).replace(/\B(?=(\d{3})+$)/g, " ");

export const circuitPath = (circuit: Pick<Circuit, "slug">) => `/circuits/${circuit.slug}.html`;
const fromPrice = (circuit: Circuit) => Math.min(...circuit.departures.map((d) => d.perPerson));
const monthOf = (departure: Departure) => Number(departure.date.slice(5, 7));
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
.card{border:1px solid #ccc;border-radius:8px;padding:12px;margin:10px 0}
label{display:inline-block;margin:6px 12px 6px 0}</style></head>
<body><header><a href="/">Far Horizons Travel</a></header>
${body}
${script ? `<script>${script}</script>` : ""}</body></html>
`;

function searchPage(): string {
  const cards = CIRCUITS.map((c) => ({
    name: c.name,
    path: circuitPath(c),
    destination: c.destination,
    days: c.days,
    from: price(fromPrice(c)),
    months: [...new Set(c.departures.map(monthOf))],
    // A card names two cities; the itinerary on the circuit's page lists them all.
    cities: `${c.cities.slice(0, 2).join(" · ")}${c.cities.length > 2 ? ` · +${c.cities.length - 2} more` : ""}`,
  }));
  const monthOptions = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  return page(
    "Find your circuit | Far Horizons Travel",
    `<h1>Find your circuit</h1>
<form id="search" onsubmit="return false">
<label>Destination <select id="destination"><option value="">Any destination</option>
<option>Japan</option><option>Vietnam</option><option>Thailand</option><option>Peru</option></select></label>
<label>Departure month <select id="month"><option value="">Any month</option>${monthOptions}</select></label>
<label>Minimum days <input id="min" type="number" min="1" max="30"></label>
<label>Maximum days <input id="max" type="number" min="1" max="30"></label>
<button type="button" id="go">Search</button>
</form>
<p id="count"></p>
<div id="results"></div>
<p><button type="button" id="prev">Previous page</button> <span id="page"></span> <button type="button" id="next">Next page</button></p>`,
    `const CARDS=${JSON.stringify(cards)};const SIZE=4;let found=CARDS,at=0;
const $=(id)=>document.getElementById(id);
function show(){const pages=Math.max(1,Math.ceil(found.length/SIZE));at=Math.min(Math.max(at,0),pages-1);
$("count").textContent=found.length+" circuits found, sorted by recommendation";
$("results").innerHTML=found.slice(at*SIZE,at*SIZE+SIZE).map((c)=>'<div class="card"><h2><a href="'+c.path+'">'+c.name+'</a></h2><p>'+c.destination+' · '+c.days+' days · '+c.cities+'</p><p>from '+c.from+' € per person</p></div>').join("")||"<p>No circuit matches.</p>";
$("page").textContent="Page "+(at+1)+" of "+pages;$("prev").disabled=at===0;$("next").disabled=at>=pages-1;}
$("go").onclick=()=>{const d=$("destination").value,m=Number($("month").value),lo=Number($("min").value)||0,hi=Number($("max").value)||99;
found=CARDS.filter((c)=>(!d||c.destination===d)&&(!m||c.months.includes(m))&&c.days>=lo&&c.days<=hi);at=0;show();};
$("prev").onclick=()=>{at--;show();};$("next").onclick=()=>{at++;show();};show();`,
  );
}

function circuitPage(circuit: Circuit): string {
  const departures = circuit.departures
    .map((d) => `<li>${d.label}: ${price(d.perPerson)} € per person</li>`)
    .join("");
  const options = circuit.departures
    .map((d) => `<option value="${d.perPerson}">${d.label}</option>`)
    .join("");
  return page(
    `${circuit.name} | Far Horizons Travel`,
    `<h1>${escapeHtml(circuit.name)}</h1>
<p>${circuit.destination} · ${circuit.days} days</p>
<h2>Itinerary</h2><ol>${circuit.cities.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ol>
<h2>Departures</h2><ul>${departures}</ul>
<h2>Get a quote</h2>
<form id="quote" onsubmit="return false">
<label>Adults <input id="adults" type="number" min="1" max="9"></label>
<label>Departure <select id="departure"><option value="">Choose a departure</option>${options}</select></label>
<button type="button" id="show">Show my quote</button>
</form>
<p id="total"></p>`,
    `const $=(id)=>document.getElementById(id);const FEE=${circuit.bookingFee};
$("show").onclick=()=>{const adults=Number($("adults").value),pp=Number($("departure").value);
if(!adults||!pp){$("total").textContent="Fill in every field to see your quote.";return;}
const total=String(adults*pp+FEE).replace(/\\B(?=(\\d{3})+$)/g," ");
$("total").textContent="Total for "+adults+" adult"+(adults>1?"s":"")+", booking fee included: "+total+" €";};`,
  );
}

/** Every file of the site by its path from the web root. */
export function travelSiteFiles(): Map<string, string> {
  return new Map([
    ["index.html", searchPage()],
    ...CIRCUITS.map((c) => [circuitPath(c).slice(1), circuitPage(c)] as [string, string]),
  ]);
}
