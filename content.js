/**
 * Content-script entry point.
 *
 * Injection may happen several times for the same tab (popup refresh, repeated
 * clicks). The newest runner supersedes the previous one instead of being
 * dropped by a boolean guard, so every popup invocation always produces a
 * result message.
 */
(() => {
  "use strict";

  const RUNNER_KEY = "__emailParserRunner";
  const TOKEN_KEY = "__emailParserRunToken";

  const previous = globalThis[RUNNER_KEY];
  if (previous && typeof previous.stop === "function") {
    previous.stop();
  }

  const scanId = globalThis[TOKEN_KEY] || `local-${Date.now()}`;
  delete globalThis[TOKEN_KEY];

  function sendEmptyResult() {
    try {
      chrome.runtime.sendMessage(
        { action: "saveEmailsForTab", scanId, emails: [], done: true, status: "error" },
        () => undefined // Consumes runtime.lastError when the popup is closed.
      );
    } catch {
      // The extension context may already be invalidated after navigation.
    }
  }

  function createRunner() {
    let scanner = null;
    let timeoutId = null;
    let stopped = false;
    let messageListener = null;

    const runner = {
      scanId,
      stop
    };

    function stop() {
      if (stopped) {
        return;
      }
      stopped = true;

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (messageListener) {
        chrome.runtime.onMessage.removeListener(messageListener);
        messageListener = null;
      }
      if (scanner) {
        scanner.requestStop();
      }
      if (globalThis[RUNNER_KEY] === runner) {
        delete globalThis[RUNNER_KEY];
      }
    }

    function handleStopRequest(message, sender) {
      if (message?.action !== "stopScanning") {
        return;
      }
      // Runtime messages cannot cross extension boundaries, but the sender id
      // is still checked as a defensive guard. Do not gate on sender.tab:
      // Chrome populates it inconsistently across Chrome versions.
      if (sender?.id && sender.id !== chrome.runtime.id) {
        return;
      }
      stop();
    }

    async function start() {
      try {
        const { EmailParserUtils, EmailScannerFactory, EmailParserConfig } = globalThis;
        if (!EmailParserUtils || !EmailScannerFactory || !EmailParserConfig) {
          sendEmptyResult();
          return;
        }

        scanner = EmailScannerFactory.createEmailScanner({
          utils: EmailParserUtils,
          runtime: chrome.runtime,
          location: window.location,
          document,
          domParser: new DOMParser(),
          scanId,
          config: EmailParserConfig
        });

        messageListener = handleStopRequest;
        chrome.runtime.onMessage.addListener(messageListener);

        // The scanner enforces its own deadline; this timer is a safety net for
        // a rejected promise or a fetch implementation that ignores abort.
        timeoutId = setTimeout(stop, EmailParserConfig.MAX_SCAN_DURATION_MS + 1_000);

        await scanner.execute();
      } catch {
        if (!scanner) {
          sendEmptyResult();
        }
      } finally {
        stop();
      }
    }

    return { start, stop, scanId };
  }

  const runner = createRunner();
  globalThis[RUNNER_KEY] = runner;
  runner.start();
})();
