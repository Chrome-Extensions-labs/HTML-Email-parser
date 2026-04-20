(() => {
  const MAX_EMAILS = 8;
  const MAX_RUNTIME_MS = 20000;
  const FETCH_TIMEOUT_MS = 4500;

  const SCAN_SELECTOR = [
    "a", "p", "span", "div", "li", "td", "th", "header", "footer", "section", "article", "input", "textarea"
  ].join(",");

  const SCAN_ATTRIBUTES = [
    "href", "title", "placeholder", "alt", "aria-label", "data-contact", "data-email", "src", "srcset"
  ];

  const CONTACT_PATHS = [
    "/contact", "/contact/", "/contact-us", "/contact-us/", "/contacts", "/contacts/",
    "/about", "/about/", "/support", "/support/", "/help", "/help/"
  ];

  function createEmailScanner({ utils, runtime, location, document, domParser }) {
    const startedAt = Date.now();
    let stopRequested = false;

    function hasTimedOut() {
      return Date.now() - startedAt > MAX_RUNTIME_MS;
    }

    function shouldStop() {
      return stopRequested || hasTimedOut();
    }

    function requestStop() {
      stopRequested = true;
    }

    function addFromText(rawText, sink) {
      if (!rawText || shouldStop()) {
        return;
      }
      for (const email of utils.extractFromText(rawText)) {
        if (shouldStop()) {
          break;
        }
        sink.add(email);
      }
    }

    function addCandidate(rawCandidate, sink) {
      if (!rawCandidate || shouldStop()) {
        return;
      }
      const normalized = utils.sanitizeCandidate(rawCandidate);
      if (normalized) {
        sink.add(normalized);
        return;
      }
      addFromText(rawCandidate, sink);
    }

    function scanElement(element, sink) {
      if (!element || shouldStop()) {
        return;
      }

      const tagName = (element.tagName || "").toUpperCase();
      if (["IMG", "SOURCE", "PICTURE", "SVG", "CANVAS", "SCRIPT", "STYLE"].includes(tagName)) {
        return;
      }

      const cloudflareValue = element.getAttribute?.("data-cfemail");
      if (cloudflareValue) {
        addCandidate(utils.decodeCloudflareEmail(cloudflareValue), sink);
      }

      for (const attributeName of SCAN_ATTRIBUTES) {
        if (shouldStop()) {
          break;
        }
        addCandidate(element.getAttribute?.(attributeName), sink);
      }

      addFromText(element.value, sink);

      if (element.dataset) {
        for (const dataKey of Object.keys(element.dataset)) {
          if (shouldStop()) {
            break;
          }
          addFromText(element.dataset[dataKey], sink);
        }
      }

      addFromText(element.innerText || element.textContent, sink);
      addFromText(element.innerHTML, sink);
    }

    function scanDocument(doc) {
      const results = new Set();

      try {
        const rootNode = doc.body || doc.documentElement;
        if (!rootNode) {
          return results;
        }

        const walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !shouldStop()) {
          addFromText(node.textContent, results);
          node = walker.nextNode();
        }

        if (shouldStop()) {
          return results;
        }

        const elements = doc.querySelectorAll(SCAN_SELECTOR);
        for (const element of elements) {
          if (shouldStop()) {
            break;
          }
          scanElement(element, results);
        }

        if (shouldStop()) {
          return results;
        }

        const styleNodes = doc.querySelectorAll("style");
        for (const styleNode of styleNodes) {
          if (shouldStop()) {
            break;
          }
          addFromText(styleNode.textContent, results);
        }
      } catch {
        return results;
      }

      return results;
    }

    async function fetchHtml(url) {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          redirect: "follow",
          signal: abortController.signal
        });

        if (!response.ok) {
          return null;
        }

        return await response.text();
      } catch {
        return null;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    function scanHtmlString(html) {
      const parsedDocument = domParser.parseFromString(html, "text/html");
      return scanDocument(parsedDocument);
    }

    async function scanContactPages(origin, currentUrl) {
      const results = new Set();

      for (const path of CONTACT_PATHS) {
        if (shouldStop() || results.size >= MAX_EMAILS) {
          break;
        }

        const candidateUrl = `${origin}${path}`;
        if (candidateUrl === currentUrl) {
          continue;
        }

        const html = await fetchHtml(candidateUrl);
        if (!html || shouldStop()) {
          continue;
        }

        for (const email of scanHtmlString(html)) {
          results.add(email);
          if (results.size >= MAX_EMAILS || shouldStop()) {
            break;
          }
        }
      }

      return results;
    }

    function sendResults(emailSet, done) {
      const sorted = utils.sortByBusinessPriority(Array.from(emailSet));
      runtime.sendMessage({ action: "saveEmailsForTab", emails: sorted, done }, () => {
        void chrome.runtime.lastError;
      });
    }

    async function execute() {
      const currentResults = scanDocument(document);

      if (!shouldStop() && currentResults.size < MAX_EMAILS) {
        const isRootPath = location.pathname === "/" || location.pathname === "";
        if (isRootPath || currentResults.size === 0) {
          const fallbackResults = await scanContactPages(location.origin, location.href);
          for (const email of fallbackResults) {
            currentResults.add(email);
            if (currentResults.size >= MAX_EMAILS || shouldStop()) {
              break;
            }
          }
        }
      }

      sendResults(currentResults, true);
      return currentResults;
    }

    return {
      execute,
      requestStop,
      sendPartialResults: (results) => sendResults(results, false),
      shouldStop
    };
  }

  globalThis.EmailScannerFactory = {
    createEmailScanner
  };
})();
