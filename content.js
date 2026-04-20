(() => {
  if (globalThis.__emailParserRunner?.active) {
    return;
  }

  const runnerState = {
    active: true,
    scanner: null,
    timeoutId: null,
    cleanup: null
  };
  globalThis.__emailParserRunner = runnerState;

  const hardStopTimeoutMs = 21000;

  function failSafeSendEmpty() {
    try {
      chrome.runtime.sendMessage({ action: "saveEmailsForTab", emails: [], done: true }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // ignored intentionally
    }
  }

  function cleanupRunner() {
    if (runnerState.timeoutId) {
      clearTimeout(runnerState.timeoutId);
    }

    if (runnerState.cleanup) {
      runnerState.cleanup();
    }

    runnerState.active = false;
    delete globalThis.__emailParserRunner;
  }

  function handleStopRequest(message, sender, sendResponse) {
    if (message?.action !== "stopScanning") {
      return;
    }

    runnerState.scanner?.requestStop();
    sendResponse?.({ ok: true });
  }

  async function run() {
    try {
      if (!globalThis.EmailParserUtils || !globalThis.EmailScannerFactory) {
        failSafeSendEmpty();
        cleanupRunner();
        return;
      }

      const scanner = globalThis.EmailScannerFactory.createEmailScanner({
        utils: globalThis.EmailParserUtils,
        runtime: chrome.runtime,
        location: window.location,
        document,
        domParser: new DOMParser()
      });

      runnerState.scanner = scanner;
      chrome.runtime.onMessage.addListener(handleStopRequest);
      runnerState.cleanup = () => chrome.runtime.onMessage.removeListener(handleStopRequest);

      runnerState.timeoutId = setTimeout(() => {
        if (runnerState.active) {
          scanner.requestStop();
        }
      }, hardStopTimeoutMs);

      await scanner.execute();
    } catch {
      failSafeSendEmpty();
    } finally {
      cleanupRunner();
    }
  }

  run();
})();
