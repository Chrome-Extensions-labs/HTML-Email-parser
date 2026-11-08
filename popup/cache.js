/**
 * Short-lived per-tab result cache.
 *
 * chrome.storage.session is scoped to this extension and is cleared when the
 * browser exits, which makes it appropriate for displaying the previous scan
 * immediately on popup open without retaining browsing data on disk.
 */
(() => {
  "use strict";

  const CACHE_KEY = "emailParser.results.v1";
  const MAX_ENTRIES = 12;

  function getSession() {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(CACHE_KEY, (store) => {
          void chrome.runtime.lastError;
          resolve(store || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function load(tabId) {
    if (!Number.isInteger(tabId) || !globalThis.chrome?.storage?.session) {
      return Promise.resolve(null);
    }

    return getSession().then((store) => {
      const entry = store[CACHE_KEY]?.[String(tabId)];
      return entry && typeof entry === "object" ? entry : null;
    });
  }

  function save(tabId, entry) {
    if (
      !Number.isInteger(tabId) ||
      !globalThis.chrome?.storage?.session ||
      !Array.isArray(entry?.emails)
    ) {
      return;
    }

    const config = globalThis.EmailParserConfig;
    const utils = globalThis.EmailParserUtils;
    const emails = utils
      .sortByBusinessPriority(entry.emails)
      .slice(0, config.MAX_RESULT_COUNT);

    getSession().then((store) => {
      const current = store[CACHE_KEY] && typeof store[CACHE_KEY] === "object"
        ? store[CACHE_KEY]
        : {};

      const next = { ...current, [String(tabId)]: {
        url: String(entry.url || ""),
        emails,
        savedAt: Date.now()
      } };

      // Keep the cache bounded and discard the oldest tabs first.
      const keys = Object.keys(next).sort(
        (left, right) => (next[right].savedAt || 0) - (next[left].savedAt || 0)
      );
      const pruned = {};
      for (const key of keys.slice(0, MAX_ENTRIES)) {
        pruned[key] = next[key];
      }

      try {
        chrome.storage.session.set({ [CACHE_KEY]: pruned }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        // A full or unavailable session store must never break the popup.
      }
    });
  }

  globalThis.PopupCache = Object.freeze({ load, save });
})();
