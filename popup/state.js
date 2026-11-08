/**
 * Popup state transitions. All incoming values are treated as untrusted: they
 * are validated here before they reach the renderer or the clipboard.
 */
(() => {
  "use strict";

  function createState() {
    return {
      activeTabId: null,
      tabTitle: "Email Finder",
      tabUrl: "",
      scanId: null,
      emails: [],
      loading: false,
      error: "",
      source: "",
      lastUpdated: 0
    };
  }

  function setTab(state, tab) {
    state.activeTabId = Number.isInteger(tab?.id) ? tab.id : null;
    state.tabUrl = typeof tab?.url === "string" ? tab.url : "";
    state.tabTitle = typeof tab?.title === "string" && tab.title
      ? tab.title
      : "Email Finder";
  }

  /** Returns the validated, prioritised list that was actually stored. */
  function setEmails(state, emails) {
    const config = globalThis.EmailParserConfig;
    const utils = globalThis.EmailParserUtils;
    state.emails = Array.isArray(emails)
      ? utils.sortByBusinessPriority(emails).slice(0, config.MAX_RESULT_COUNT)
      : [];
    return state.emails;
  }

  function setLoading(state, loading) {
    state.loading = Boolean(loading);
    if (state.loading) {
      state.error = "";
    }
  }

  function setError(state, message) {
    state.error = typeof message === "string" ? message : "";
    state.loading = false;
  }

  function setScanId(state, scanId) {
    state.scanId = typeof scanId === "string" && scanId.length > 0 ? scanId : null;
  }

  /** Restores a previous result while the fresh scan is still running. */
  function applyCache(state, entry) {
    if (!entry || typeof entry !== "object" || !setEmails(state, entry.emails).length) {
      return false;
    }
    state.source = "cache";
    state.lastUpdated = Number(entry.savedAt) || 0;
    return true;
  }

  /** Applies a validated content-script message and returns its completion flag. */
  function applyMessage(state, message) {
    const emails = setEmails(state, message.emails);
    const done = message.done === true;

    state.loading = !done;
    state.source = "scan";
    if (done) {
      state.lastUpdated = Date.now();
    }

    if (message.status === "error" && done) {
      setError(state, "The scan could not read this page.");
    } else if (message.status === "cancelled" && done && emails.length === 0) {
      setError(state, "The scan was interrupted. Please try Refresh.");
    } else if (done) {
      state.error = "";
    }

    return { emails, done };
  }

  globalThis.PopupState = Object.freeze({
    applyCache,
    applyMessage,
    createState,
    setEmails,
    setError,
    setLoading,
    setScanId,
    setTab
  });
})();
