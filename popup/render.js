/**
 * Popup view. Rendering is isolated from orchestration, and all dynamic values
 * are assigned through textContent or dataset so page-derived strings can never
 * become markup.
 */
(() => {
  "use strict";

  function hostnameOf(rawUrl) {
    try {
      return new URL(rawUrl).hostname || rawUrl;
    } catch {
      return rawUrl || "No active tab";
    }
  }

  function createStatusNode(message, className) {
    const node = document.createElement("li");
    node.className = className;
    node.textContent = message;
    return node;
  }

  function createView(elements) {
    const { list, title, meta, summary, refreshButton, copyAllButton } = elements;
    const copyTimers = new WeakMap();

    function renderStatus(message, className = "status") {
      list.replaceChildren(createStatusNode(message, className));
    }

    function renderEmailList(emails) {
      const fragment = document.createDocumentFragment();

      for (const email of emails) {
        const row = document.createElement("li");
        row.className = "email-row";

        const address = document.createElement("span");
        address.className = "email-text";
        address.textContent = email;

        const actions = document.createElement("span");
        actions.className = "btn-group";

        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "btn";
        copyButton.textContent = "Copy";
        copyButton.dataset.action = "copy";
        copyButton.dataset.email = email;
        copyButton.setAttribute("aria-label", `Copy ${email}`);

        const mailLink = document.createElement("a");
        mailLink.className = "btn btn-primary";
        mailLink.href = `mailto:${email}`;
        mailLink.textContent = "Mail";
        mailLink.setAttribute("aria-label", `Compose an email to ${email}`);

        actions.append(copyButton, mailLink);
        row.append(address, actions);
        fragment.append(row);
      }

      list.replaceChildren(fragment);
    }

    function renderSummary(state) {
      const count = state.emails.length;
      if (state.error) {
        summary.textContent = state.error;
      } else if (state.loading && count > 0) {
        summary.textContent = `Checking contact pages — ${count} found so far.`;
      } else if (state.loading) {
        summary.textContent = "Scanning this page…";
      } else if (count > 0) {
        const noun = count === 1 ? "address" : "addresses";
        summary.textContent = state.source === "cache"
          ? `${count} ${noun} from the previous scan.`
          : `${count} ${noun} found.`;
      } else {
        summary.textContent = "No email addresses found.";
      }
    }

    function render(state) {
      title.textContent = state.tabTitle;
      meta.textContent = hostnameOf(state.tabUrl);
      renderSummary(state);

      if (state.emails.length > 0) {
        renderEmailList(state.emails);
      } else if (state.loading) {
        renderStatus("Searching for email addresses…", "status status-loading");
      } else {
        renderStatus(
          state.error || "No emails found on this page.",
          state.error ? "status status-error" : "status status-empty"
        );
      }

      refreshButton.disabled = state.loading;
      refreshButton.textContent = state.loading ? "Scanning…" : "Refresh";
      copyAllButton.disabled = state.emails.length === 0;
      list.setAttribute("aria-busy", String(state.loading));
    }

    /** Provides brief, accessible feedback after a clipboard action. */
    function flashCopy(button, succeeded, label = "Copy") {
      const pending = copyTimers.get(button);
      if (pending) {
        clearTimeout(pending);
      }

      button.textContent = succeeded ? "Copied" : "Failed";
      button.classList.toggle("btn-success", succeeded);
      button.classList.toggle("btn-error", !succeeded);

      copyTimers.set(button, setTimeout(() => {
        button.textContent = label;
        button.classList.remove("btn-success", "btn-error");
        copyTimers.delete(button);
      }, 1_400));
    }

    return Object.freeze({ render, flashCopy });
  }

  globalThis.PopupRender = Object.freeze({ createView });
})();
