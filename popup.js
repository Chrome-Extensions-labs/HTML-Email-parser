/**
 * Popup orchestrator: resolves the active tab, restores the previous result,
 * injects the scanner and applies validated messages to the state.
 */
document.addEventListener("DOMContentLoaded", async () => {
  "use strict";

  const config = globalThis.EmailParserConfig;
  const utils = globalThis.EmailParserUtils;
  const state = globalThis.PopupState.createState();

  const elements = {
    list: document.getElementById("list"),
    title: document.getElementById("pageTitle"),
    meta: document.getElementById("meta"),
    summary: document.getElementById("summary"),
    refreshButton: document.getElementById("refreshBtn"),
    copyAllButton: document.getElementById("copyAllBtn")
  };
  const view = globalThis.PopupRender.createView(elements);
  let watchdogId = null;

  function render() {
    view.render(state);
  }

  function clearWatchdog() {
    if (watchdogId !== null) {
      clearTimeout(watchdogId);
      watchdogId = null;
    }
  }

  function armWatchdog() {
    clearWatchdog();
    watchdogId = setTimeout(() => {
      if (!state.loading) {
        return;
      }
      globalThis.PopupState.setError(state, "The scan did not finish in time. Please try Refresh.");
      render();
      requestStop(state.activeTabId);
    }, config.POPUP_WATCHDOG_MS);
  }

  async function copyText(value) {
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // The asynchronous API can be blocked by focus or permission policies.
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.className = "clipboard-fallback";
    textArea.setAttribute("readonly", "");
    textArea.setAttribute("aria-hidden", "true");
    document.body.append(textArea);

    try {
      textArea.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textArea.remove();
    }
  }

  async function onListClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("button[data-action='copy']");
    if (!button || !elements.list.contains(button)) {
      return;
    }
    const email = button.dataset.email;
    if (!utils.isValidEmail(email)) {
      return;
    }
    view.flashCopy(button, await copyText(email));
  }

  async function onCopyAllClick() {
    if (state.emails.length === 0) {
      return;
    }
    const succeeded = await copyText(state.emails.join("\n"));
    view.flashCopy(elements.copyAllButton, succeeded, "Copy all");
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] || null;
  }

  async function requestStop(tabId) {
    if (!Number.isInteger(tabId)) {
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, { action: "stopScanning" });
    } catch {
      // No content script is listening on this tab yet.
    }
  }

  function createScanId() {
    return typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** Passes a run token through the isolated world before injecting the bundle. */
  async function injectScanner(tabId, scanId) {
    const target = { tabId };
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: (token) => {
        globalThis.__emailParserRunToken = token;
      },
      args: [scanId]
    });
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      files: [
        "shared/config.js",
        "shared/email-utils.js",
        "content/scanner.js",
        "content.js"
      ]
    });
  }

  function onMessage(message, sender) {
    if (message?.action !== "saveEmailsForTab") {
      return;
    }
    // Only the content script running in the tab that started this run is
    // allowed to update the UI; stale or foreign messages are discarded.
    if (sender?.id && sender.id !== chrome.runtime.id) {
      return;
    }
    if (!sender?.tab || sender.tab.id !== state.activeTabId) {
      return;
    }
    if (message.scanId !== state.scanId) {
      return;
    }

    const { done } = globalThis.PopupState.applyMessage(state, message);
    render();

    if (done) {
      clearWatchdog();
      // A failed or cancelled scan must not overwrite a previously good result.
      if (message.status !== "error" && message.status !== "cancelled") {
        globalThis.PopupCache.save(state.activeTabId, {
          url: state.tabUrl,
          emails: state.emails
        });
      }
    }
  }

  async function runScan() {
    if (state.loading) {
      return;
    }
    clearWatchdog();

    if (!Number.isInteger(state.activeTabId)) {
      globalThis.PopupState.setError(state, "No active tab is available for scanning.");
      render();
      return;
    }

    const scanId = createScanId();
    globalThis.PopupState.setScanId(state, scanId);
    globalThis.PopupState.setLoading(state, true);
    render();
    armWatchdog();

    try {
      await requestStop(state.activeTabId);
      await injectScanner(state.activeTabId, scanId);
    } catch {
      clearWatchdog();
      globalThis.PopupState.setError(
        state,
        "This page cannot be scanned. Chrome blocks extensions on browser and store pages."
      );
      render();
    }
  }

  elements.list.addEventListener("click", onListClick);
  elements.refreshButton.addEventListener("click", runScan);
  elements.copyAllButton.addEventListener("click", onCopyAllClick);
  chrome.runtime.onMessage.addListener(onMessage);

  window.addEventListener("pagehide", () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    clearWatchdog();
    // Callback form is used here: the popup can be torn down before a promise
    // based sendMessage settles.
    if (Number.isInteger(state.activeTabId)) {
      try {
        chrome.tabs.sendMessage(state.activeTabId, { action: "stopScanning" }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        // The tab may already be closed.
      }
    }
  });

  try {
    const activeTab = await getActiveTab();
    globalThis.PopupState.setTab(state, activeTab);
    render();

    if (Number.isInteger(state.activeTabId)) {
      const cached = await globalThis.PopupCache.load(state.activeTabId);
      if (cached?.url === state.tabUrl) {
        globalThis.PopupState.applyCache(state, cached);
        render();
      }
    }
  } catch {
    globalThis.PopupState.setError(state, "The active tab could not be read.");
    render();
  }

  await runScan();
});
