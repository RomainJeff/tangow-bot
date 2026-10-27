import type { Criterion } from "../../evals/cases.js";
import { TRAVEL_SITE_URL } from "./site.js";

export type BrowserTask = { id: string; ask: string; grade: (reply: string) => Criterion[] };

/** "5 600 €", "5,600" and "5600" read alike; any other text stays as written. */
const digits = (text: string) => text.replace(/(\d)[\s  ,.'](?=\d{3}(?!\d))/g, "$1");
const has = (reply: string, pattern: RegExp) => pattern.test(digits(reply));
const names = (reply: string, name: string) => reply.toLowerCase().includes(name.toLowerCase());
const amount = (value: number) => new RegExp(`(?<![\\d])${value}(?![\\d])`);
const days = (value: number) => new RegExp(`(?<![\\d])${value}[\\s-]*days?\\b`, "i");
const inOrder = (reply: string, words: readonly string[]) => {
  const at = words.map((word) => reply.toLowerCase().indexOf(word.toLowerCase()));
  return at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1]!));
};

/** The benchmark task. Never tune a prompt on it: the development tasks below are for that. */
export const BENCHMARK_TASK: BrowserTask = {
  id: "travel-cheapest-april-circuit",
  ask: `On the travel site at ${TRAVEL_SITE_URL}, find the 10 to 14 day Japan circuit departing in April that visits Kyoto and Hiroshima at the lowest price. Give its name, its total price for 2 adults, its duration and its link.`,
  grade: (reply) => [
    { id: "name", pass: names(reply, "Rising Sun Discovery") },
    { id: "total-for-2-adults", pass: has(reply, amount(5600)) },
    { id: "duration", pass: has(reply, days(13)) },
    { id: "link", pass: reply.includes("/circuits/rising-sun-discovery.html") },
  ],
};

export const DEVELOPMENT_TASKS: readonly BrowserTask[] = [
  {
    id: "travel-read-itinerary",
    ask: `On the travel site at ${TRAVEL_SITE_URL}, open the Mekong Delta and Saigon circuit. Tell me its duration and every city on its itinerary, in order.`,
    grade: (reply) => [
      { id: "duration", pass: has(reply, days(8)) },
      {
        id: "itinerary-in-order",
        pass: inOrder(reply, ["Ho Chi Minh City", "Cu Chi", "Ben Tre", "Can Tho", "Chau Doc"]),
      },
    ],
  },
  {
    id: "travel-filter-duration",
    ask: `On the travel site at ${TRAVEL_SITE_URL}, list every Vietnam circuit of 8 to 10 days with its "from" price per person.`,
    grade: (reply) => [
      {
        id: "every-match",
        pass:
          names(reply, "Mekong Delta and Saigon") &&
          names(reply, "Northern Mountains Trek") &&
          names(reply, "Vietnam Highlights"),
      },
      {
        id: "their-prices",
        pass: [1290, 1450, 1590].every((value) => has(reply, amount(value))),
      },
    ],
  },
  {
    id: "travel-fill-quote",
    ask: `On the travel site at ${TRAVEL_SITE_URL}, use the quote form of the Thai Islands Escape circuit to get the total price for 2 adults on its 8 May 2027 departure.`,
    grade: (reply) => [{ id: "quoted-total", pass: has(reply, amount(3160)) }],
  },
];
