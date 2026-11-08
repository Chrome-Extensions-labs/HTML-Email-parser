/**
 * Runtime limits shared by the popup and the injected content-script bundle.
 *
 * Both contexts load this file as a classic script, which keeps the UI watchdog
 * and the scanner on the same budget without a module bundler or build step.
 */
(() => {
  "use strict";

  const config = Object.freeze({
    /** Stop augmenting results once this many addresses have been collected. */
    TARGET_RESULT_COUNT: 8,

    /** Hard ceiling for collected and rendered addresses. */
    MAX_RESULT_COUNT: 50,

    /** Upper bound for the entire scan, including same-origin augmentation. */
    MAX_SCAN_DURATION_MS: 12_000,

    /** Popup fallback in case the content script never reports completion. */
    POPUP_WATCHDOG_MS: 16_000,

    /** Per-request timeout and total number of candidate pages to request. */
    FETCH_TIMEOUT_MS: 3_500,
    MAX_CONCURRENT_FETCHES: 3,
    MAX_CONTACT_URLS: 6,

    /** Defensive input ceilings for untrusted page content. */
    MAX_TEXT_LENGTH: 100_000,
    MAX_CANDIDATE_LENGTH: 2_048,
    MAX_HTML_LENGTH: 1_500_000,

    /** Attributes worth inspecting on every element. */
    SCAN_ATTRIBUTES: Object.freeze([
      "href", "title", "placeholder", "alt", "aria-label", "content",
      "data-contact", "data-email", "src", "srcset"
    ]),

    /** Elements whose attributes cannot contain a meaningful contact address. */
    EXCLUDED_TAGS: Object.freeze([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS"
    ]),

    /** Curated fallback routes, used when the current page yields too little. */
    CONTACT_PATHS: Object.freeze([
      "/contact", "/contact-us", "/contacts", "/about", "/support",
      "/help", "/impressum", "/team"
    ])
  });

  globalThis.EmailParserConfig = config;

  // The CommonJS reference exists solely for the Node-based unit tests.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = config;
  }
})();
