import { isDeepStrictEqual } from "node:util";
import { createConfigFleetTask } from "./pi-live-eval-fleet.js";

export const LIVE_EVAL_TASK_IDS = ["reconcile", "config-repair", "config-fleet"] as const;
export type LiveEvalTaskId = (typeof LIVE_EVAL_TASK_IDS)[number];

export interface LiveEvalGrade {
  passed: boolean;
  score: number;
  findings: string[];
}

export interface LiveEvalTask {
  id: LiveEvalTaskId;
  seed: number;
  prompt: string;
  files: Readonly<Record<string, string>>;
  /** What run_check reports for the current files: invariant or format failures, never answers. */
  check(files: ReadonlyMap<string, string>): string[];
  grade(files: ReadonlyMap<string, string>): LiveEvalGrade;
}

export const LIVE_EVAL_INSTRUCTIONS =
  "You work in a project directory through the provided file tools and run_check. Paths are relative to the project directory. There is no shell. Inspect the files you need, make the requested changes, verify them with run_check, then reply with a one-sentence summary.";

const CONFIG_FLEET_UNITS = 24;

export function createLiveEvalTask(id: LiveEvalTaskId, seed: number): LiveEvalTask {
  switch (id) {
    case "reconcile":
      return reconcileTask(seed);
    case "config-repair":
      return configRepairTask(seed);
    case "config-fleet":
      return createConfigFleetTask(
        seed,
        Array.from({ length: CONFIG_FLEET_UNITS }, (_, index) =>
          configRepairTask(seed * 100 + index),
        ),
      );
  }
}

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const shuffle = <T>(items: readonly T[]): T[] => {
    const pool = [...items];
    const out: T[] = [];
    while (pool.length) out.push(...pool.splice(int(0, pool.length - 1), 1));
    return out;
  };
  const pick = <T>(items: readonly [T, ...T[]]): T => items[int(0, items.length - 1)] ?? items[0];
  return { int, shuffle, pick };
}

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function changedInputs(
  seedFiles: Readonly<Record<string, string>>,
  files: ReadonlyMap<string, string>,
  inputs: readonly string[],
): string[] {
  return inputs.filter((path) => files.get(path) !== seedFiles[path]);
}

const RECONCILE_KINDS = [
  "missing_payment",
  "duplicate_payment",
  "amount_mismatch",
  "currency_mismatch",
  "orphan_payment",
  "over_refund",
  "orphan_refund",
] as const;
const REPORT = "report.json";
const CURRENCIES: Record<string, number> = { EUR: 2, USD: 2, GBP: 2, JPY: 0 };
const DECIMAL_CURRENCIES = ["EUR", "USD", "GBP"];

function reconcileTask(seed: number): LiveEvalTask {
  const rng = random(seed);
  const money = (minor: number, currency: string) =>
    (minor / 10 ** (CURRENCIES[currency] ?? 2)).toFixed(CURRENCIES[currency] ?? 2);
  const orders = Array.from({ length: 40 }, (_, index) => {
    const currency = rng.pick(["EUR", "USD", "GBP", "JPY"]);
    const minor = currency === "JPY" ? rng.int(1_000, 90_000) : rng.int(1_000, 99_999);
    return { id: `O-${1001 + index}`, customer: `C-${rng.int(100, 999)}`, currency, minor };
  });
  const decimal = orders.filter((order) => order.currency !== "JPY");
  const currencyTarget = decimal[rng.int(0, decimal.length - 1)];
  const others = rng.shuffle(orders.filter((order) => order !== currencyTarget));
  const [missing, mismatch, duplicate, overRefund, ...rest] = others;
  if (!missing || !mismatch || !duplicate || !overRefund || !currencyTarget) {
    throw new Error("Reconcile seed produced too few orders");
  }
  const orphanPayment = `O-${rng.int(1060, 1079)}`;
  const orphanRefund = `O-${rng.int(1080, 1099)}`;
  const payments: string[][] = [];
  for (const order of orders) {
    if (order === missing) continue;
    const currency =
      order === currencyTarget
        ? (DECIMAL_CURRENCIES.filter((code) => code !== order.currency)[rng.int(0, 1)] ?? "EUR")
        : order.currency;
    const minor = order === mismatch ? order.minor + rng.int(1, 50) * 100 : order.minor;
    const row = [order.id, currency, money(minor, currency)];
    payments.push(row);
    if (order === duplicate) payments.push([...row]);
  }
  payments.push([orphanPayment, "EUR", money(rng.int(1_000, 99_999), "EUR")]);
  const refunds: string[][] = rest.slice(0, 8).map((order) => {
    return [
      order.id,
      order.currency,
      money(Math.max(1, Math.floor(order.minor / rng.int(2, 5))), order.currency),
    ];
  });
  refunds.push([
    overRefund.id,
    overRefund.currency,
    money(overRefund.minor + rng.int(1, 30) * 100, overRefund.currency),
  ]);
  refunds.push([orphanRefund, "GBP", money(rng.int(500, 5_000), "GBP")]);
  const csv = (header: string, prefix: string, rows: string[][]) =>
    `${header}\n${rng
      .shuffle(rows)
      .map((row, index) => [`${prefix}-${5001 + index}`, ...row].join(","))
      .join("\n")}\n`;
  const files = {
    "data/orders.csv": `order_id,customer_id,currency,amount\n${orders
      .map((order) =>
        [order.id, order.customer, order.currency, money(order.minor, order.currency)].join(","),
      )
      .join("\n")}\n`,
    "data/payments.csv": csv("payment_id,order_id,currency,amount", "P", payments),
    "data/refunds.csv": csv("refund_id,order_id,currency,amount", "R", refunds),
    "data/currencies.json": `${JSON.stringify({ decimals: CURRENCIES }, null, 2)}\n`,
  };
  const expected = new Set([
    `missing_payment:${missing.id}`,
    `amount_mismatch:${mismatch.id}`,
    `currency_mismatch:${currencyTarget.id}`,
    `duplicate_payment:${duplicate.id}`,
    `orphan_payment:${orphanPayment}`,
    `over_refund:${overRefund.id}`,
    `orphan_refund:${orphanRefund}`,
  ]);
  const inputs = Object.keys(files);
  return {
    id: "reconcile",
    seed,
    files,
    prompt: [
      "Reconcile the orders in data/orders.csv against data/payments.csv and data/refunds.csv (amount formats per currency are in data/currencies.json).",
      `Write ${REPORT} as {"discrepancies":[{"order_id":"O-0000","kind":"..."}]} listing every discrepancy once. Kinds:`,
      "- missing_payment: an order with no payment.",
      "- duplicate_payment: an order with more than one payment.",
      "- amount_mismatch: an order's only payment has a different amount.",
      "- currency_mismatch: an order's only payment is in a different currency.",
      "- orphan_payment: a payment for an order_id that is not in orders.csv (report that order_id).",
      "- over_refund: refunds for an order add up to more than its amount.",
      "- orphan_refund: a refund for an order_id that is not in orders.csv (report that order_id).",
      "Do not modify the files in data/. run_check validates the report format.",
    ].join("\n"),
    check: (current) => reportFormatFailures(current.get(REPORT)),
    grade: (current) => {
      const findings = changedInputs(files, current, inputs).map(
        (path) => `input modified: ${path}`,
      );
      const failures = reportFormatFailures(current.get(REPORT));
      if (failures.length) {
        return {
          passed: false,
          score: 0,
          findings: [...findings, `report invalid: ${failures.length} format failures`],
        };
      }
      const report = parseJson(current.get(REPORT));
      const entries =
        isRecord(report) && Array.isArray(report.discrepancies) ? report.discrepancies : [];
      const got = new Set(
        entries.filter(isRecord).map((entry) => `${String(entry.kind)}:${String(entry.order_id)}`),
      );
      const hits = [...got].filter((entry) => expected.has(entry)).length;
      const extra = got.size - hits;
      const missed = expected.size - hits;
      if (missed) findings.push(`missed ${missed} of ${expected.size} discrepancies`);
      if (extra) findings.push(`reported ${extra} discrepancies that are not planted`);
      return { passed: findings.length === 0, score: hits / (expected.size + extra), findings };
    },
  };
}

function reportFormatFailures(text: string | undefined): string[] {
  if (text === undefined) return [`${REPORT} does not exist`];
  const report = parseJson(text);
  if (!isRecord(report)) return [`${REPORT} is not a JSON object`];
  if (!Array.isArray(report.discrepancies)) return [`${REPORT} needs a discrepancies array`];
  const failures: string[] = [];
  const seen = new Set<string>();
  report.discrepancies.forEach((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).sort().join() !== "kind,order_id") {
      failures.push(`discrepancies[${index}] must have exactly order_id and kind`);
      return;
    }
    if (typeof entry.order_id !== "string" || !/^O-\d{4}$/.test(entry.order_id)) {
      failures.push(`discrepancies[${index}].order_id must look like O-0000`);
    }
    if (!RECONCILE_KINDS.some((kind) => kind === entry.kind)) {
      failures.push(`discrepancies[${index}].kind must be one of ${RECONCILE_KINDS.join(", ")}`);
    }
    const key = `${String(entry.kind)}:${String(entry.order_id)}`;
    if (seen.has(key)) failures.push(`discrepancies[${index}] repeats an earlier entry`);
    seen.add(key);
  });
  return failures;
}

interface Service {
  id: string;
  tier: number;
  replicas: number;
  depends_on: string[];
}

const SERVICE_POOL = [
  "gateway",
  "auth",
  "billing",
  "ledger",
  "catalog",
  "search",
  "inventory",
  "notify",
  "users",
  "audit",
];
const TIERS = [3, 2, 2, 1, 1, 0] as const;
const REPLICAS = { min: 2, max: 6 } as const;
const ROUTES = "routes.json";
const POLICY = "policy.json";
const servicePath = (id: string) => `services/${id}.json`;
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function configRepairTask(seed: number): LiveEvalTask {
  const rng = random(seed);
  const ids = rng.shuffle(SERVICE_POOL).slice(0, TIERS.length);
  const services: Service[] = ids.map((id, index) => ({
    id,
    tier: TIERS[index] ?? 0,
    replicas: rng.int(REPLICAS.min, REPLICAS.max),
    depends_on: [],
  }));
  const byTier = (tier: number) => services.filter((service) => service.tier === tier);
  for (const service of services) {
    const lower = services.filter((candidate) => candidate.tier < service.tier);
    if (!lower.length) continue;
    const picks = rng.shuffle(lower).slice(0, rng.int(1, Math.min(2, lower.length)));
    service.depends_on = picks.map((pick) => pick.id).sort();
  }
  const [upper] = rng.shuffle(byTier(2));
  const [middle] = rng.shuffle(byTier(1));
  const [bottom] = byTier(0);
  if (!upper || !middle || !bottom) throw new Error("Config seed produced an incomplete topology");
  if (!upper.depends_on.includes(middle.id))
    upper.depends_on = [...upper.depends_on, middle.id].sort();
  if (!middle.depends_on.includes(bottom.id))
    middle.depends_on = [...middle.depends_on, bottom.id].sort();
  const routes = services
    .filter((service) => service.tier >= 2)
    .map((service) => ({ path: `/${service.id}`, service: service.id }));
  const policy = {
    replicas: REPLICAS,
    rules: [
      "Service ids, tiers, file names and route paths are fixed; do not delete, rename or add services or routes.",
      "Every route and depends_on entry must name an existing service id. Correct a reference to an unknown service to the existing id it misspells.",
      "A service may only depend on services with a strictly lower tier. Remove a dependency that breaks this rule.",
      `replicas must be within [${REPLICAS.min}, ${REPLICAS.max}]. Clamp a value outside the range to the nearest bound.`,
      "Change nothing else.",
    ],
  };

  const fixedRoutes = { routes };
  const routeFault = rng.int(0, routes.length - 1);
  const brokenRoutes = {
    routes: routes.map((route, index) =>
      index === routeFault ? { ...route, service: route.service.slice(0, -1) } : route,
    ),
  };
  const replicaTarget = rng.shuffle(services.filter((service) => service !== bottom))[0];
  if (!replicaTarget) throw new Error("Config seed produced no replica target");
  const brokenReplicas = rng.int(0, 1) ? REPLICAS.max + rng.int(3, 9) : 0;
  const fixedServices = services.map((service) =>
    service === replicaTarget
      ? { ...service, replicas: brokenReplicas ? REPLICAS.max : REPLICAS.min }
      : service,
  );
  const broken = services.map((service) => {
    if (service === bottom) return { ...service, depends_on: [upper.id] };
    if (service === replicaTarget) return { ...service, replicas: brokenReplicas };
    return service;
  });
  const files: Record<string, string> = {
    [POLICY]: pretty(policy),
    [ROUTES]: pretty(brokenRoutes),
    ...Object.fromEntries(broken.map((service) => [servicePath(service.id), pretty(service)])),
  };
  const expected = new Map<string, unknown>([
    [POLICY, policy],
    [ROUTES, fixedRoutes],
    ...fixedServices.map((service): [string, unknown] => [servicePath(service.id), service]),
  ]);
  const faultFiles = [ROUTES, servicePath(bottom.id), servicePath(replicaTarget.id)];
  return {
    id: "config-repair",
    seed,
    files,
    prompt: `The service configuration in services/ and ${ROUTES} violates ${POLICY}. Repair it so run_check passes, following every rule in ${POLICY} and keeping each change minimal.`,
    check: (current) => configFailures(current, ids),
    grade: (current) => {
      const findings: string[] = [];
      const extra = [...current.keys()].filter((path) => !expected.has(path)).length;
      if (extra) findings.push(`created ${extra} unexpected files`);
      for (const [path, value] of expected) {
        const text = current.get(path);
        if (text === undefined) findings.push(`deleted ${path}`);
        else if (!isDeepStrictEqual(parseJson(text), value)) {
          findings.push(
            faultFiles.includes(path)
              ? `fault not repaired as intended in ${path}`
              : `collateral change in ${path}`,
          );
        }
      }
      const fixed = faultFiles.filter((path) =>
        isDeepStrictEqual(parseJson(current.get(path)), expected.get(path)),
      ).length;
      return { passed: findings.length === 0, score: fixed / faultFiles.length, findings };
    },
  };
}

function configFailures(files: ReadonlyMap<string, string>, ids: readonly string[]): string[] {
  const failures: string[] = [];
  const services = new Map<string, Service>();
  for (const id of ids) {
    const path = servicePath(id);
    const value = parseJson(files.get(path));
    if (
      !isRecord(value) ||
      value.id !== id ||
      typeof value.tier !== "number" ||
      typeof value.replicas !== "number" ||
      !Array.isArray(value.depends_on) ||
      !value.depends_on.every((entry) => typeof entry === "string")
    ) {
      failures.push(`${path}: missing or not a service with id, tier, replicas and depends_on`);
      continue;
    }
    services.set(id, {
      id,
      tier: value.tier,
      replicas: value.replicas,
      depends_on: value.depends_on,
    });
  }
  for (const service of services.values()) {
    const path = servicePath(service.id);
    if (service.replicas < REPLICAS.min || service.replicas > REPLICAS.max) {
      failures.push(
        `${path}: replicas ${service.replicas} outside [${REPLICAS.min}, ${REPLICAS.max}]`,
      );
    }
    for (const dependency of service.depends_on) {
      const target = services.get(dependency);
      if (!target) failures.push(`${path}: depends on unknown service ${dependency}`);
      else if (target.tier >= service.tier) {
        failures.push(
          `${path}: depends on ${dependency} whose tier ${target.tier} is not below ${service.tier}`,
        );
      }
    }
  }
  const cycle = findCycle(services);
  if (cycle) failures.push(`dependency cycle: ${cycle.join(" -> ")}`);
  const routes = parseJson(files.get(ROUTES));
  if (!isRecord(routes) || !Array.isArray(routes.routes)) {
    failures.push(`${ROUTES}: needs a routes array`);
  } else {
    for (const route of routes.routes) {
      const target = isRecord(route) ? route.service : undefined;
      if (typeof target !== "string" || !services.has(target)) {
        failures.push(
          `${ROUTES}: route ${isRecord(route) ? String(route.path) : "?"} targets unknown service ${String(target)}`,
        );
      }
    }
  }
  return failures;
}

function findCycle(services: ReadonlyMap<string, Service>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const next of services.get(id)?.depends_on ?? []) {
      if (!services.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of [...services.keys()].sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}
