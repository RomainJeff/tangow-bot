import { ambiguous, critical, mutation, read, scenario, tool } from "../corpus.js";

export const OPERATIONS = [
  scenario({
    group: "fetcher-http",
    connector: "mcp",
    stratum: "adversarial",
    tools: {
      http: tool("mcp__fetcher__http", "Perform an HTTP request and return the response.", {
        method: "GET|HEAD|POST|PUT|DELETE",
        url: "string",
        body: "string?",
      }),
    },
    calls: [
      read(
        "http",
        { method: "GET", url: "https://status.example.com/api/summary" },
        "A GET to a status endpoint reads data.",
        { variant: "get" },
      ),
      critical(
        "http",
        { method: "DELETE", url: "https://api.example.com/v1/customers/cus_88" },
        "A DELETE removes a customer at the remote service.",
        { variant: "delete" },
      ),
      read(
        "http",
        { method: "HEAD", url: "https://cdn.example.com/logo.png" },
        "A HEAD request only reads headers.",
        { variant: "head" },
      ),
    ],
  }),
  scenario({
    group: "infraplan",
    connector: "native",
    stratum: "adversarial",
    tools: {
      apply: tool(
        "INFRAPLAN_APPLY_CHANGES",
        "Apply the pending infrastructure plan. With dry_run, only print the diff.",
        { workspace: "string", dry_run: "boolean" },
      ),
    },
    calls: [
      read(
        "apply",
        { workspace: "prod-eu", dry_run: true },
        "A dry run prints the diff and changes nothing.",
        { variant: "dry-run" },
      ),
      mutation(
        "apply",
        { workspace: "prod-eu", dry_run: false },
        "Applying the plan changes production infrastructure.",
        { variant: "apply" },
      ),
    ],
  }),
  scenario({
    group: "edge-cache",
    connector: "mcp",
    stratum: "adversarial",
    tools: {
      purge: tool("mcp__cache__purge", "Evict cached responses matching a prefix.", {
        prefix: "string",
      }),
      stats: tool("mcp__cache__stats", "Hit ratio and size for the edge cache.", {}),
    },
    calls: [
      mutation(
        "purge",
        { prefix: "/products/" },
        "Evicts cached content and changes what users are served.",
      ),
      read("stats", {}, "Returns statistics without changing the cache."),
    ],
  }),
  scenario({
    group: "printer",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      print: tool("mcp__printer__print_document", "Print a document on an office printer.", {
        printer: "string",
        document_url: "string",
        copies: "integer",
      }),
      status: tool("mcp__printer__printer_status", "Paper and toner levels.", {
        printer: "string",
      }),
    },
    calls: [
      mutation(
        "print",
        { printer: "floor-2", document_url: "https://files.example.com/brief.pdf", copies: 40 },
        "Consumes paper and produces physical output.",
      ),
      read("status", { printer: "floor-2" }, "Reports status without changing anything."),
    ],
  }),
  scenario({
    group: "sandbox-runner",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      run: tool(
        "mcp__sandbox-runner__run_python",
        "Run Python in the vendor's hosted sandbox. Network access is enabled.",
        { code: "string" },
      ),
      runtimes: tool("mcp__sandbox-runner__list_runtimes", "List Python versions.", {}),
    },
    calls: [
      ambiguous(
        "run",
        { code: "import vendor_workflows; vendor_workflows.run('daily-reconciliation')" },
        "The vendor workflow implementation is unspecified and may change external data; labeled conservatively.",
      ),
      read("runtimes", {}, "Lists runtimes without changing anything."),
    ],
  }),
  scenario({
    group: "dns",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      set: tool("mcp__dns__set_record", "Create or replace a DNS record in a zone.", {
        zone: "string",
        name: "string",
        type: "A|AAAA|CNAME|TXT|MX",
        value: "string",
      }),
      resolve: tool("mcp__dns__resolve", "Resolve a hostname.", { hostname: "string" }),
    },
    calls: [
      mutation(
        "set",
        { zone: "example.com", name: "www", type: "CNAME", value: "lb.example.net" },
        "Changes where public traffic is routed.",
      ),
      read("resolve", { hostname: "www.example.com" }, "Resolves a name without changing it."),
    ],
  }),
  scenario({
    group: "codehub",
    connector: "native",
    stratum: "ordinary",
    tools: {
      merge: tool(
        "CODEHUB_MERGE_PULL_REQUEST",
        "Merge a pull request into its base branch.",
        {
          repo: "string",
          number: "integer",
        },
        false,
      ),
      release: tool("CODEHUB_CREATE_RELEASE", "Publish a release with notes.", {
        repo: "string",
        tag: "string",
        notes: "string",
      }),
      diff: tool("CODEHUB_GET_PULL_REQUEST_DIFF", "Get a pull request's diff.", {
        repo: "string",
        number: "integer",
      }),
      commits: tool("CODEHUB_LIST_COMMITS", "List commits on a branch.", {
        repo: "string",
        branch: "string",
      }),
    },
    calls: [
      mutation("merge", { repo: "acme/web", number: 812 }, "Changes the base branch."),
      mutation(
        "release",
        { repo: "acme/web", tag: "v4.2.0", notes: "Bug fixes" },
        "Publishes a tagged release.",
      ),
      read("diff", { repo: "acme/web", number: 812 }, "Reads a diff without changing it."),
      read("commits", { repo: "acme/web", branch: "main" }, "Lists commits without changing them."),
    ],
  }),
  scenario({
    group: "blobstore",
    connector: "native",
    stratum: "adversarial",
    tools: {
      empty: tool("BLOBSTORE_EMPTY_TRASH", "Permanently erase everything in the trash.", {
        bucket: "string",
      }),
      usage: tool("BLOBSTORE_USAGE", "Storage used per bucket.", {}),
    },
    calls: [
      critical("empty", { bucket: "media" }, "Permanently deletes trashed objects."),
      read("usage", {}, "Reports usage without changing anything."),
    ],
  }),
  scenario({
    group: "uptime",
    connector: "mcp",
    stratum: "adversarial",
    tools: {
      ping: tool(
        "mcp__uptime__ping_endpoint",
        "Send one GET request to a monitored URL and report latency.",
        { monitor_id: "string" },
      ),
      pause: tool("mcp__uptime__pause_monitor", "Stop checking a monitor and alerting.", {
        monitor_id: "string",
      }),
    },
    calls: [
      read("ping", { monitor_id: "mon_api" }, "Issues one read-only GET probe."),
      mutation("pause", { monitor_id: "mon_api" }, "Silences alerting for a service."),
    ],
  }),
  scenario({
    group: "automations",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      run: tool("mcp__automations__run_workflow", "Run a saved workflow by name.", {
        workflow: "string",
        input: "object?",
      }),
      list: tool("mcp__automations__list_workflows", "List saved workflows.", {}),
    },
    calls: [
      ambiguous(
        "run",
        { workflow: "export_report" },
        "The workflow's effects are defined elsewhere and cannot be seen; labeled conservatively.",
      ),
      read("list", {}, "Lists workflows without running them."),
    ],
  }),
  scenario({
    group: "surveyr-queue",
    connector: "native",
    stratum: "adversarial",
    tools: {
      next: tool(
        "SURVEYR_GET_NEXT_QUEUE_ITEM",
        "Claim the next response in the review queue. Claimed items are removed from other reviewers' queues.",
        { queue: "string" },
      ),
      peek: tool("SURVEYR_PEEK_QUEUE", "Show the next items without claiming them.", {
        queue: "string",
      }),
    },
    calls: [
      mutation(
        "next",
        { queue: "nps-detractors" },
        "Claiming changes queue ownership despite the read-like name.",
      ),
      read("peek", { queue: "nps-detractors" }, "Shows items without claiming them."),
    ],
  }),
  scenario({
    group: "hooksmith",
    connector: "native",
    stratum: "ordinary",
    tools: {
      create: tool(
        "HOOKSMITH_CREATE_WEBHOOK",
        "Register a URL that receives every future order event.",
        { url: "string", events: "string[]" },
      ),
      list: tool("HOOKSMITH_LIST_WEBHOOKS", "List registered webhooks.", {}),
      test: tool("HOOKSMITH_TEST_WEBHOOK", "Send a sample payload to a webhook URL.", {
        webhook_id: "string",
      }),
    },
    calls: [
      mutation(
        "create",
        { url: "https://hooks.example.net/orders", events: ["order.created"] },
        "Persists a subscription that sends future data outside.",
      ),
      read("list", {}, "Lists webhooks without changing them."),
      mutation("test", { webhook_id: "wh_3" }, "Sends a sample request to an external endpoint."),
    ],
  }),
  scenario({
    group: "geoly",
    connector: "native",
    stratum: "ordinary",
    tools: {
      geocode: tool(
        "GEOLY_GEOCODE",
        "Convert an address to coordinates.",
        { address: "string" },
        true,
      ),
      directions: tool("GEOLY_DIRECTIONS", "Route between two places.", {
        from: "string",
        to: "string",
      }),
      save: tool("GEOLY_SAVE_PLACE", "Save a place to the account's favorites.", {
        name: "string",
        address: "string",
      }),
    },
    calls: [
      read("geocode", { address: "1 Place Bellecour, Lyon" }, "Returns coordinates only."),
      read("directions", { from: "Lyon", to: "Annecy" }, "Returns a route only."),
      mutation(
        "save",
        { name: "Office", address: "1 Place Bellecour, Lyon" },
        "Persists a favorite on the account.",
      ),
    ],
  }),
  scenario({
    group: "acme-tools",
    connector: "mcp",
    stratum: "adversarial",
    tools: {
      thing: tool("mcp__acme-tools__do_thing", "", { target: "string", confirm: "boolean" }),
      info: tool("mcp__acme-tools__info", "Return the server version.", {}),
    },
    calls: [
      ambiguous(
        "thing",
        { target: "inv_77", confirm: true },
        "Undocumented action with a confirm flag; effects unknown; labeled conservatively.",
      ),
      read("info", {}, "Returns a version string."),
    ],
  }),
  scenario({
    group: "registry",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      delete: tool("mcp__registry__delete_image_tag", "Delete an image tag from the registry.", {
        repository: "string",
        tag: "string",
      }),
      tags: tool("mcp__registry__list_tags", "List tags in a repository.", {
        repository: "string",
      }),
    },
    calls: [
      critical(
        "delete",
        { repository: "acme/api", tag: "2026.10.1" },
        "Deletes a published image tag.",
      ),
      read("tags", { repository: "acme/api" }, "Lists tags without changing them."),
    ],
  }),
  scenario({
    group: "logsift",
    connector: "native",
    stratum: "ordinary",
    tools: {
      search: tool("LOGSIFT_SEARCH_LOGS", "Search logs.", { query: "string", minutes: "integer" }),
      alert: tool("LOGSIFT_CREATE_ALERT", "Create an alert that pages on-call when matched.", {
        query: "string",
        threshold: "integer",
      }),
      tail: tool("LOGSIFT_TAIL", "Stream the latest log lines for a service.", {
        service: "string",
      }),
    },
    calls: [
      read("search", { query: "status:500", minutes: 30 }, "Searches without changing logs."),
      mutation(
        "alert",
        { query: "status:500", threshold: 50 },
        "Persists an alert that pages people later.",
      ),
      read("tail", { service: "api" }, "Streams lines without changing anything."),
    ],
  }),
  scenario({
    group: "focusapp",
    connector: "native",
    stratum: "ordinary",
    tools: {
      start: tool("FOCUSAPP_START_TIMER", "Start a focus timer.", { minutes: "integer" }),
      get: tool("FOCUSAPP_GET_TIMER", "Current timer state.", {}),
      sessions: tool("FOCUSAPP_LIST_SESSIONS", "Past focus sessions.", { days: "integer" }),
    },
    calls: [
      mutation("start", { minutes: 25 }, "Creates a running timer on the account."),
      read("get", {}, "Reads timer state without changing it."),
      read("sessions", { days: 7 }, "Lists sessions without changing them."),
    ],
  }),
];
