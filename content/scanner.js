/**
 * Page scanner. All browser dependencies are injected by the runner so the
 * extraction pipeline can be exercised with a synthetic DOM in unit tests.
 */
(() => {
  "use strict";

  /** NodeFilter.SHOW_TEXT from the DOM Level 2 Traversal specification. */
  const SHOW_TEXT = 0x4;
  const CONTACT_HINT_RE =
    /(?:contact|about|support|help|impressum|imprint|kontakt|team|connect|reach)/i;

  /** Cheap guard that skips the regex pipeline for the vast majority of nodes. */
  const EMAIL_HINT_RE = /@|＠|&#64;|%40|\[at\]|\(at\)|\s+at\s+|\[dot\]|\(dot\)|\s+dot\s+/i;

  function createEmailScanner(dependencies) {
    const {
      utils,
      runtime,
      location,
      document,
      domParser,
      scanId,
      config = globalThis.EmailParserConfig,
      fetchImpl = globalThis.fetch.bind(globalThis),
      now = () => Date.now()
    } = dependencies;

    const startedAt = now();
    const activeControllers = new Set();
    const scanAttributes = new Set(config.SCAN_ATTRIBUTES);
    const excludedTags = new Set(config.EXCLUDED_TAGS);
    let stopRequested = false;
    let operations = 0;

    function shouldStop() {
      return stopRequested || now() - startedAt > config.MAX_SCAN_DURATION_MS;
    }

    /** Checks the clock at most once per 64 nodes to keep the walk linear. */
    function budgetExceeded() {
      operations += 1;
      return (operations & 63) === 0 && shouldStop();
    }

    function requestStop() {
      stopRequested = true;
      for (const controller of activeControllers) {
        controller.abort();
      }
    }

    function createSink(limit) {
      const emails = new Set();
      return {
        emails,
        capacity: limit,
        get size() {
          return emails.size;
        },
        get full() {
          return emails.size >= limit;
        },
        add(email) {
          if (emails.size >= limit || !utils.isValidEmail(email)) {
            return false;
          }
          emails.add(email.toLowerCase());
          return true;
        }
      };
    }

    function addFromText(rawText, sink) {
      if (
        typeof rawText !== "string" ||
        rawText.length === 0 ||
        shouldStop() ||
        !EMAIL_HINT_RE.test(rawText)
      ) {
        return;
      }

      const remaining = sink.capacity - sink.size;
      if (remaining <= 0) {
        return;
      }

      for (const email of utils.extractFromText(rawText, remaining)) {
        sink.add(email);
        if (shouldStop() || sink.full) {
          return;
        }
      }
    }

    function addCandidate(rawCandidate, sink) {
      if (typeof rawCandidate !== "string" || rawCandidate.length === 0 || shouldStop()) {
        return;
      }

      // Attribute values frequently contain an entire mailto URL or percent
      // encoded address; text extraction alone would miss those forms.
      const direct = utils.sanitizeCandidate(rawCandidate);
      if (direct) {
        sink.add(direct);
      }
      if (!sink.full) {
        addFromText(rawCandidate, sink);
      }
    }

    function scanElement(element, sink) {
      const tagName = String(element.tagName || "").toUpperCase();
      if (excludedTags.has(tagName)) {
        return;
      }

      for (const attribute of element.attributes || []) {
        const name = String(attribute.name || "").toLowerCase();
        const value = attribute.value;
        if (typeof value !== "string" || value.length === 0) {
          continue;
        }

        if (name === "data-cfemail") {
          addCandidate(utils.decodeCloudflareEmail(value), sink);
        } else if (
          (scanAttributes.has(name) || name.startsWith("data-")) &&
          EMAIL_HINT_RE.test(value)
        ) {
          addCandidate(value.slice(0, config.MAX_CANDIDATE_LENGTH), sink);
        }

        if (shouldStop() || sink.full) {
          return;
        }
      }

      if ((tagName === "INPUT" || tagName === "TEXTAREA") && !sink.full) {
        addFromText(element.value, sink);
      }
    }

    /**
     * Two linear passes cover the document: one TreeWalker over text nodes and
     * one over element attributes. Serialising innerHTML or reading innerText
     * per element would re-walk every subtree (quadratic work and forced
     * reflow), so neither is used.
     */
    function scanDocument(doc, sink) {
      const rootNode = doc.body || doc.documentElement;
      if (!rootNode) {
        return;
      }

      try {
        const walker = doc.createTreeWalker(rootNode, SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          addFromText(node.nodeValue ?? node.textContent, sink);
          if (budgetExceeded() || sink.full) {
            return;
          }
          node = walker.nextNode();
        }

        if (shouldStop() || sink.full) {
          return;
        }

        for (const element of doc.querySelectorAll("*")) {
          scanElement(element, sink);
          if (budgetExceeded() || sink.full) {
            return;
          }
        }
      } catch {
        // A detached or mutated node must not abort the whole scan.
      }
    }

    function isSameOrigin(candidate, base) {
      try {
        return new URL(candidate, base).origin === new URL(base).origin;
      } catch {
        return false;
      }
    }

    function collectContactUrls() {
      if (location.protocol !== "http:" && location.protocol !== "https:") {
        return [];
      }

      const urls = [];
      const seen = new Set();
      const originUrl = new URL(location.href);

      const addUrl = (url) => {
        if (urls.length >= config.MAX_CONTACT_URLS || shouldStop()) {
          return;
        }
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.origin !== originUrl.origin ||
          url.href === originUrl.href
        ) {
          return;
        }
        const key = `${url.pathname.replace(/\/+$/, "")}${url.search}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        urls.push(url.href);
      };

      // Links already present on the page are a stronger signal than guesses.
      for (const anchor of document.querySelectorAll("a[href]")) {
        const href = typeof anchor.getAttribute === "function"
          ? anchor.getAttribute("href")
          : anchor.href;
        if (typeof href !== "string" || href.length === 0) {
          continue;
        }
        if (/^(?:mailto:|tel:|javascript:|#)/i.test(href) || !CONTACT_HINT_RE.test(href)) {
          continue;
        }
        try {
          addUrl(new URL(href, originUrl));
        } catch {
          // Ignore malformed links; the curated paths still provide coverage.
        }
      }

      for (const path of config.CONTACT_PATHS) {
        try {
          addUrl(new URL(path, originUrl));
        } catch {
          // The path list is static; a failure here is not recoverable.
        }
      }

      return urls;
    }

    /**
     * Reads at most MAX_HTML_LENGTH characters. Streaming prevents a large or
     * slow response from being buffered in full before the size check runs.
     */
    async function readBoundedHtml(response) {
      const limit = config.MAX_HTML_LENGTH;
      if (typeof response.body?.getReader !== "function") {
        const html = await response.text();
        return typeof html === "string" && html.length <= limit ? html : null;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          html += decoder.decode(value, { stream: true });
          if (html.length > limit) {
            await reader.cancel();
            return null;
          }
        }
        html += decoder.decode();
        return html.length <= limit ? html : null;
      } finally {
        reader.releaseLock();
      }
    }

    async function fetchHtml(url) {
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeoutId = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);

      try {
        const response = await fetchImpl(url, {
          // Probes are unauthenticated by design: guessing contact routes must
          // never transmit the user's cookies to additional endpoints.
          credentials: "omit",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: controller.signal
        });

        if (!response || !response.ok) {
          return null;
        }
        if (response.url && !isSameOrigin(response.url, location.href)) {
          return null;
        }

        const headers = response.headers;
        const contentType = typeof headers?.get === "function" ? headers.get("content-type") : "";
        if (contentType && !/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
          return null;
        }
        const declaredLength = Number(
          typeof headers?.get === "function" ? headers.get("content-length") : 0
        );
        if (Number.isFinite(declaredLength) && declaredLength > config.MAX_HTML_LENGTH) {
          return null;
        }

        return await readBoundedHtml(response);
      } catch {
        return null;
      } finally {
        clearTimeout(timeoutId);
        activeControllers.delete(controller);
      }
    }

    function scanHtmlString(html, sink) {
      try {
        scanDocument(domParser.parseFromString(html, "text/html"), sink);
      } catch {
        // DOMParser can reject malformed payloads; other pages remain usable.
      }
    }

    async function scanContactPages(sink) {
      const urls = collectContactUrls();
      const workerCount = Math.min(config.MAX_CONCURRENT_FETCHES, urls.length);
      if (!workerCount || shouldStop()) {
        return;
      }

      let cursor = 0;
      const workers = Array.from({ length: workerCount }, async () => {
        while (!shouldStop() && sink.size < config.TARGET_RESULT_COUNT) {
          const index = cursor;
          cursor += 1;
          if (index >= urls.length) {
            return;
          }

          const html = await fetchHtml(urls[index]);
          if (html && !shouldStop()) {
            scanHtmlString(html, sink);
          }
        }
      });

      await Promise.all(workers);
    }

    /** Swallows the missing-receiver error raised when the popup has closed. */
    function report(sink, done, status = "ok") {
      try {
        runtime.sendMessage(
          {
            action: "saveEmailsForTab",
            scanId,
            emails: utils.sortByBusinessPriority(Array.from(sink.emails)),
            done,
            status
          },
          () => undefined
        );
      } catch {
        // Messaging is best effort; results remain available to a later scan.
      }
    }

    function needsFallback(resultsFound) {
      if (location.protocol !== "http:" && location.protocol !== "https:") {
        return false;
      }
      const pathname = location.pathname || "/";
      return resultsFound === 0 || pathname === "/" || pathname === "";
    }

    async function execute() {
      const sink = createSink(config.MAX_RESULT_COUNT);
      let status = "ok";

      try {
        scanDocument(document, sink);

        // Publish on-page findings immediately while contact pages are probed.
        if (sink.size > 0 && !shouldStop()) {
          report(sink, false);
        }

        if (
          !shouldStop() &&
          sink.size < config.TARGET_RESULT_COUNT &&
          needsFallback(sink.size)
        ) {
          await scanContactPages(sink);
        }

        if (stopRequested) {
          status = "cancelled";
        }
      } catch {
        status = "error";
      } finally {
        report(sink, true, status);
      }

      return { emails: Array.from(sink.emails), status };
    }

    return { execute, requestStop, shouldStop };
  }

  globalThis.EmailScannerFactory = Object.freeze({ createEmailScanner });

  // The CommonJS reference exists solely for the Node-based unit tests.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createEmailScanner };
  }
})();
