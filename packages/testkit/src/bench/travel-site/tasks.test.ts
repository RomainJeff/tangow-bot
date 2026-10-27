import { describe, expect, it } from "vitest";
import { CIRCUITS } from "./site.js";
import { BENCHMARK_TASK } from "./tasks.js";

const failed = (reply: string) =>
  BENCHMARK_TASK.grade(reply)
    .filter((check) => !check.pass)
    .map((check) => check.id);

describe("the benchmark grader", () => {
  it("passes the right circuit with its total, duration and link", () => {
    expect(
      failed(
        "Rising Sun Discovery: 5 600 € for 2 adults, 13 days, http://127.0.0.1:8765/circuits/rising-sun-discovery.html",
      ),
    ).toEqual([]);
  });

  it("fails a total without the booking fee", () => {
    expect(
      failed(
        "Rising Sun Discovery: 5 480 € for 2 adults, 13 days, http://127.0.0.1:8765/circuits/rising-sun-discovery.html",
      ),
    ).toEqual(["total-for-2-adults"]);
  });

  it("fails the cheaper circuit that departs only in March", () => {
    expect(
      failed(
        "Cherry Blossom Trail: 4 390 € for 2 adults, 11 days, http://127.0.0.1:8765/circuits/cherry-blossom-trail.html",
      ),
    ).toEqual(["name", "total-for-2-adults", "duration", "link"]);
  });

  it("fails the cheaper April circuit that skips Hiroshima", () => {
    expect(
      failed(
        "Essential Japan: 4 670 € for 2 adults, 12 days, http://127.0.0.1:8765/circuits/essential-japan.html",
      ),
    ).toEqual(["name", "total-for-2-adults", "duration", "link"]);
  });
});

it("holds exactly one answer to the benchmark task in its data", () => {
  const matches = CIRCUITS.flatMap((circuit) =>
    circuit.destination === "Japan" &&
    circuit.days >= 10 &&
    circuit.days <= 14 &&
    circuit.cities.includes("Kyoto") &&
    circuit.cities.includes("Hiroshima")
      ? circuit.departures
          .filter((departure) => departure.date.slice(5, 7) === "04")
          .map((departure) => ({
            name: circuit.name,
            total: 2 * departure.perPerson + circuit.bookingFee,
          }))
      : [],
  ).sort((a, b) => a.total - b.total);
  expect(matches).toEqual([
    { name: "Rising Sun Discovery", total: 5600 },
    { name: "Peace and Temples", total: 5870 },
    { name: "Japan Grand Tour", total: 7110 },
  ]);
});
