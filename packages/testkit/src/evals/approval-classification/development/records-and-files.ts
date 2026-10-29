import { critical, mutation, read, scenario, tool } from "../corpus.js";

export const RECORDS_AND_FILES = [
  scenario({
    group: "filestore",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      delete: tool(
        "mcp__filestore__delete_file",
        "Delete a file. There is no trash.",
        {
          path: "string",
        },
        false,
      ),
      move: tool("mcp__filestore__move_file", "Move or rename a file.", {
        from: "string",
        to: "string",
      }),
      readFile: tool("mcp__filestore__read_file", "Read a file's text content.", {
        path: "string",
      }),
      list: tool("mcp__filestore__list_directory", "List entries in a directory.", {
        path: "string",
      }),
    },
    calls: [
      critical("delete", { path: "/finance/2025/ledger.xlsx" }, "Permanently removes a file."),
      mutation(
        "move",
        { from: "/drafts/plan.md", to: "/archive/plan.md" },
        "Changes where a file lives for every user.",
      ),
      read("readFile", { path: "/drafts/plan.md" }, "Reads content without changing it."),
      read("list", { path: "/drafts" }, "Lists entries without changing them."),
    ],
  }),
  scenario({
    group: "warehouse-sql",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      sql: tool(
        "mcp__warehouse__execute_sql",
        "Execute a SQL statement against the analytics warehouse and return rows.",
        { sql: "string" },
      ),
    },
    calls: [
      read(
        "sql",
        { sql: "SELECT country, count(*) FROM signups GROUP BY country" },
        "A SELECT returns rows without changing data.",
        { variant: "select" },
      ),
      mutation(
        "sql",
        { sql: "UPDATE accounts SET plan = 'pro' WHERE id = 42" },
        "An UPDATE changes stored rows.",
        { variant: "update" },
      ),
      critical(
        "sql",
        { sql: "DROP TABLE marketing_events" },
        "DROP TABLE permanently deletes a table.",
        { variant: "drop" },
      ),
      critical(
        "sql",
        { sql: "SELECT id FROM sessions; DELETE FROM sessions WHERE created_at < now()" },
        "The second statement deletes rows behind a leading SELECT.",
        { variant: "stacked", stratum: "adversarial" },
      ),
    ],
  }),
  scenario({
    group: "graphapi",
    connector: "native",
    stratum: "ordinary",
    tools: {
      graphql: tool(
        "GRAPHAPI_GRAPHQL",
        "Send a GraphQL document to the project API. Queries read data, mutations change it.",
        { document: "string", variables: "object?" },
      ),
    },
    calls: [
      read(
        "graphql",
        { document: "query { project(id: 7) { name members { login } } }" },
        "A GraphQL query only reads data.",
        { variant: "query" },
      ),
      mutation(
        "graphql",
        {
          document: "mutation($id: ID!) { archiveProject(id: $id) { id } }",
          variables: { id: "7" },
        },
        "A GraphQL mutation archives a project.",
        { variant: "mutation" },
      ),
      read(
        "graphql",
        { document: "query { __schema { types { name } } }" },
        "Introspection reads the schema only.",
        { variant: "introspection" },
      ),
    ],
  }),
  scenario({
    group: "notebox",
    connector: "native",
    stratum: "adversarial",
    tools: {
      page: tool(
        "NOTEBOX_PAGE",
        "Access a notebook page. mode=view returns the page, mode=replace overwrites it with content.",
        { page_id: "string", mode: "view|replace", content: "string?" },
      ),
    },
    calls: [
      read("page", { page_id: "pg_1", mode: "view" }, "View mode returns the page only.", {
        variant: "view",
      }),
      mutation(
        "page",
        { page_id: "pg_1", mode: "replace", content: "New text" },
        "Replace mode overwrites the stored page.",
        { variant: "replace" },
      ),
    ],
  }),
  scenario({
    group: "glossary",
    connector: "mcp",
    stratum: "adversarial",
    tools: {
      preview: tool(
        "mcp__glossary__create_preview",
        "Render a preview of pending glossary edits. Nothing is saved.",
        { edits: "object" },
      ),
      commit: tool("mcp__glossary__commit_changes", "Save pending glossary edits.", {
        edits: "object",
      }),
    },
    calls: [
      read(
        "preview",
        { edits: { "sales qualified lead": "SQL" } },
        "Renders a preview without saving, despite the create verb.",
      ),
      mutation(
        "commit",
        { edits: { "sales qualified lead": "SQL" } },
        "Persists shared glossary edits.",
      ),
    ],
  }),
  scenario({
    group: "contactbook",
    connector: "native",
    stratum: "ordinary",
    tools: {
      import: tool("CONTACTBOOK_BULK_IMPORT", "Import contacts from CSV text.", { csv: "string" }),
      vcard: tool("CONTACTBOOK_EXPORT_VCARD", "Return contacts as vCard text.", {
        group: "string?",
      }),
    },
    calls: [
      mutation(
        "import",
        { csv: "name,email\nAda,ada@example.com" },
        "Adds contacts to the shared address book.",
      ),
      read("vcard", { group: "vendors" }, "Returns text without changing anything."),
    ],
  }),
  scenario({
    group: "wikiloop",
    connector: "mcp",
    stratum: "ordinary",
    catalog: "mcp_execute_tool",
    tools: {
      update: tool("mcp__wikiloop__update_page", "Replace a page body.", {
        page: "string",
        body: "string",
      }),
      get: tool("mcp__wikiloop__get_page", "Get a page body.", { page: "string" }, true),
      history: tool("mcp__wikiloop__page_history", "List a page's revisions.", {
        page: "string",
      }),
    },
    calls: [
      mutation(
        "update",
        { page: "Onboarding", body: "Updated checklist" },
        "Overwrites a shared page.",
      ),
      read("get", { page: "Onboarding" }, "Reads a page without changing it."),
      read("history", { page: "Onboarding" }, "Lists revisions without changing them."),
    ],
  }),
  scenario({
    group: "crmsync",
    connector: "native",
    stratum: "ordinary",
    tools: {
      sync: tool(
        "CRMSYNC_SYNC_NOW",
        "Pull the latest records from the remote CRM into the local copy.",
        {},
      ),
      status: tool("CRMSYNC_LAST_SYNC_STATUS", "When the last sync ran and its result.", {}),
    },
    calls: [
      mutation("sync", {}, "Overwrites the local CRM copy from the remote source."),
      read("status", {}, "Reports status without changing anything."),
    ],
  }),
  scenario({
    group: "vectra",
    connector: "native",
    stratum: "ordinary",
    tools: {
      upsert: tool("VECTRA_UPSERT_VECTORS", "Insert or replace vectors in an index.", {
        index: "string",
        vectors: "object[]",
      }),
      query: tool("VECTRA_QUERY_VECTORS", "Nearest neighbours of a vector.", {
        index: "string",
        vector: "number[]",
        top_k: "integer",
      }),
      describe: tool(
        "VECTRA_DESCRIBE_INDEX",
        "Dimensions and size of an index.",
        {
          index: "string",
        },
        false,
      ),
    },
    calls: [
      mutation(
        "upsert",
        { index: "docs", vectors: [{ id: "d1", values: [0.1, 0.2] }] },
        "Writes vectors to a shared index.",
      ),
      read(
        "query",
        { index: "docs", vector: [0.1, 0.2], top_k: 5 },
        "Searches without changing the index.",
      ),
      read(
        "describe",
        { index: "docs" },
        "Describes the index without changing it, despite a readOnly=false hint.",
      ),
    ],
  }),
  scenario({
    group: "gridsheet",
    connector: "native",
    stratum: "adversarial",
    tools: {
      values: tool(
        "GRIDSHEET_VALUES",
        "Work with a cell range. operation=read returns values, write sets them, clear erases them.",
        { sheet_id: "string", range: "string", operation: "read|write|clear", values: "array?" },
      ),
    },
    calls: [
      read(
        "values",
        { sheet_id: "sh_1", range: "A1:C10", operation: "read" },
        "Read returns cell values.",
        { variant: "read" },
      ),
      mutation(
        "values",
        { sheet_id: "sh_1", range: "A1", operation: "write", values: [["Total"]] },
        "Write changes cells.",
        { variant: "write" },
      ),
      critical(
        "values",
        { sheet_id: "sh_1", range: "A1:Z1000", operation: "clear" },
        "Clear erases a large range.",
        { variant: "clear" },
      ),
    ],
  }),
  scenario({
    group: "analytics-refresh",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      refresh: tool(
        "mcp__analytics__refresh_dashboard",
        "Recompute a dashboard's cached aggregates now.",
        { dashboard_id: "string" },
      ),
      get: tool("mcp__analytics__get_dashboard", "Return a dashboard's tiles and values.", {
        dashboard_id: "string",
      }),
    },
    calls: [
      mutation(
        "refresh",
        { dashboard_id: "dash_revenue" },
        "Rewrites the shared cached aggregates.",
      ),
      read("get", { dashboard_id: "dash_revenue" }, "Reads values without changing them."),
    ],
  }),
  scenario({
    group: "trackr",
    connector: "native",
    stratum: "ordinary",
    tools: {
      log: tool("TRACKR_LOG_EVENT", "Record a product analytics event.", {
        name: "string",
        properties: "object?",
      }),
      query: tool("TRACKR_QUERY_EVENTS", "Count events by name over a period.", {
        name: "string",
        days: "integer",
      }),
    },
    calls: [
      mutation(
        "log",
        { name: "report_generated", properties: { pages: 3 } },
        "Appends a persistent analytics event.",
      ),
      read("query", { name: "report_generated", days: 7 }, "Counts events without changing them."),
    ],
  }),
  scenario({
    group: "inboxio",
    connector: "native",
    stratum: "adversarial",
    tools: {
      mark: tool("INBOXIO_MARK_AS_READ", "Mark messages as read.", { message_ids: "string[]" }),
      count: tool("INBOXIO_COUNT_UNREAD", "Number of unread messages per folder.", {}),
    },
    calls: [
      mutation("mark", { message_ids: ["m1", "m2"] }, "Changes the stored read state of messages."),
      read("count", {}, "Counts messages without changing them."),
    ],
  }),
  scenario({
    group: "contacts-compound",
    connector: "native",
    stratum: "adversarial",
    tools: {
      searchUpdate: tool(
        "CONTACTS_SEARCH_AND_UPDATE",
        "Find contacts matching a query and apply the given field changes to each.",
        { query: "string", changes: "object" },
      ),
      findCreate: tool(
        "CONTACTS_FIND_OR_CREATE",
        "Return the contact with this email, creating it when missing.",
        { email: "string", name: "string?" },
      ),
      lookup: tool("CONTACTS_LOOKUP", "Look up a contact by email.", { email: "string" }),
    },
    calls: [
      mutation(
        "searchUpdate",
        { query: "company:Acme", changes: { owner: "sam" } },
        "Updates every matching contact.",
      ),
      mutation(
        "findCreate",
        { email: "new.lead@example.com", name: "New Lead" },
        "Creates a contact when none exists.",
      ),
      read("lookup", { email: "new.lead@example.com" }, "Looks up a contact without changing it."),
    ],
  }),
  scenario({
    group: "salesdesk",
    connector: "mcp",
    stratum: "ordinary",
    tools: {
      stage: tool("mcp__salesdesk__update_deal_stage", "Move a deal to another stage.", {
        deal_id: "string",
        stage: "string",
      }),
      get: tool("mcp__salesdesk__get_deal", "Get a deal by id.", { deal_id: "string" }),
      summary: tool(
        "mcp__salesdesk__deal_pipeline_summary",
        "Totals per pipeline stage for the current quarter.",
        { pipeline: "string" },
      ),
    },
    calls: [
      mutation("stage", { deal_id: "d_19", stage: "closed_won" }, "Changes a shared CRM record."),
      read("get", { deal_id: "d_19" }, "Reads a deal without changing it."),
      read("summary", { pipeline: "enterprise" }, "Aggregates deals without changing them."),
    ],
  }),
  scenario({
    group: "bugtrack",
    connector: "native",
    stratum: "ordinary",
    catalog: "composio_execute_tool",
    tools: {
      create: tool("BUGTRACK_CREATE_ISSUE", "Open a new issue in a project.", {
        project: "string",
        title: "string",
        body: "string?",
      }),
      comment: tool("BUGTRACK_ADD_COMMENT", "Comment on an issue. Watchers are notified.", {
        issue_id: "string",
        body: "string",
      }),
      search: tool("BUGTRACK_SEARCH_ISSUES", "Search issues by text and status.", {
        query: "string",
        status: "open|closed|all",
      }),
      get: tool("BUGTRACK_GET_ISSUE", "Get an issue with its comments.", { issue_id: "string" }),
    },
    calls: [
      mutation(
        "create",
        { project: "WEB", title: "Checkout button misaligned" },
        "Creates a persistent issue in a shared tracker.",
      ),
      mutation(
        "comment",
        { issue_id: "WEB-311", body: "Reproduced on staging." },
        "Adds a comment and notifies watchers.",
      ),
      read(
        "search",
        { query: "checkout", status: "open" },
        "Searches issues without changing them.",
      ),
      read("get", { issue_id: "WEB-311" }, "Reads one issue without changing it."),
    ],
  }),
  scenario({
    group: "tickets-actions",
    connector: "mcp",
    stratum: "adversarial",
    tools: {
      ticket: tool("mcp__tickets__ticket", "Operate on a support ticket.", {
        id: "string",
        action: "show|assign|delete",
        assignee: "string?",
      }),
    },
    calls: [
      read("ticket", { id: "S-90", action: "show" }, "Show returns the ticket.", {
        variant: "show",
      }),
      critical("ticket", { id: "S-90", action: "delete" }, "Delete removes the ticket.", {
        variant: "delete",
      }),
      mutation(
        "ticket",
        { id: "S-90", action: "assign", assignee: "kim" },
        "Assign changes ownership.",
        { variant: "assign" },
      ),
    ],
  }),
];
