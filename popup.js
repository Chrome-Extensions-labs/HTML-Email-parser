document.addEventListener("DOMContentLoaded", async () => {
  const listElement = document.getElementById("list");
  const metaElement = document.getElementById("meta");
  const titleElement = document.getElementById("pageTitle");
  const refreshButton = document.getElementById("refreshBtn");

  const state = globalThis.PopupState.createState();

  async function copyText(value) {
    if (!value) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // fall through to execCommand fallback
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
  }

  function render() {
    if (state.loading) {
      globalThis.PopupRender.renderStatus(listElement, "Searching emails...", "status status-loading");
      return;
    }

    globalThis.PopupRender.renderEmailList(listElement, state.emails, copyText);
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] || null;
  }

  async function requestStop(tabId) {
    if (!tabId) {
      return;
    }

    await chrome.tabs.sendMessage(tabId, { action: "stopScanning" }).catch(() => undefined);
  }

  async function injectScanner(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared/email-utils.js", "content/scanner.js", "content.js"]
    });
  }

  async function runScan() {
    if (!state.activeTabId) {
      globalThis.PopupState.setLoading(state, false);
      globalThis.PopupState.setEmails(state, []);
      render();
      return;
    }

    globalThis.PopupState.setLoading(state, true);
    render();

    try {
      await requestStop(state.activeTabId);
      await injectScanner(state.activeTabId);
    } catch {
      globalThis.PopupState.setLoading(state, false);
      globalThis.PopupState.setEmails(state, []);
      render();
    }
  }

  const onMessage = (message, sender) => {
    if (message?.action !== "saveEmailsForTab") {
      return;
    }

    if (sender.tab?.id && sender.tab.id !== state.activeTabId) {
      return;
    }

    globalThis.PopupState.setEmails(state, message.emails || []);
    globalThis.PopupState.setLoading(state, !message.done);
    render();
  };

  chrome.runtime.onMessage.addListener(onMessage);

  const activeTab = await getActiveTab();
  globalThis.PopupState.setActiveTabId(state, activeTab?.id);

  titleElement.textContent = activeTab?.title || "Email Finder";
  metaElement.textContent = activeTab?.url || "No active tab";

  refreshButton.addEventListener("click", runScan);

  window.addEventListener("unload", () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    if (state.activeTabId) {
      chrome.tabs.sendMessage(state.activeTabId, { action: "stopScanning" }, () => {
        void chrome.runtime.lastError;
      });
    }
  });

  await runScan();
});
