import { fetch as undiciFetch } from "undici";

/**
 * Every `dispatcher` we pass belongs to the `undici` package, but Node's global fetch
 * drives it with the handler shape of the undici it bundles. On Node 22 those differ
 * (undici 8 handlers want `onRequestStart`) and every request dies as
 * `fetch failed: invalid onRequestStart method (UND_ERR_INVALID_ARG)`. Dispatching
 * through undici's own fetch keeps both halves on one version.
 */
export const dispatchableFetch = undiciFetch as unknown as typeof globalThis.fetch;
