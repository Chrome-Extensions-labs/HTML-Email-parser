"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const utils = require("../shared/email-utils.js");
const baseConfig = require("../shared/config.js");
const { createEmailScanner } = require("../content/scanner.js");
const { createDomParser, createFakeDocument, createHeaders } = require("./fake-dom.js");

const config = {
  ...baseConfig,
  FETCH_TIMEOUT_MS: 200,
  MAX_SCAN_DURATION_MS: 2_000,
  MAX_CONTACT_URLS: 3,
  MAX_CONCURRENT_FETCHES: 2,
  CONTACT_PATHS: ["/contact", "/about"]
};

function createRuntime() {
  const messages = [];
  return {
    messages,
    sendMessage(message, callback) {
      messages.push(message);
      if (typeof callback === "function") {
        callback();
      }
    }
  };
}

function createLocation(overrides = {}) {
  return {
    href: "https://example.com/about",
    origin: "https://example.com",
    protocol: "https:",
    pathname: "/about",
    ...overrides
  };
}

function createScanner(overrides = {}) {
  const runtime = createRuntime();
  const requests = [];
  const scanner = createEmailScanner({
    utils,
    config,
    runtime,
    location: createLocation(),
    document: createFakeDocument(),
    domParser: createDomParser(new Map()),
    scanId: "scan-1",
    now: () => 0,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: false };
    },
    ...overrides
  });
  return { scanner, runtime, requests };
}

test("scans text nodes and attributes in two linear passes", async () => {
  let encoded = "2a";
  for (const character of "cf@example.com") {
    encoded += (character.charCodeAt(0) ^ 0x2a).toString(16).padStart(2, "0");
  }

  const document = createFakeDocument([
    { kind: "text", value: "Reach us at sales@example.com" },
    { kind: "text", value: "press [at] example [dot] com" },
    { kind: "element", tagName: "A", attributes: { href: "mailto:hello@example.com?subject=Hi" } },
    { kind: "element", tagName: "DIV", attributes: { "data-contact": "team@example.com" } },
    { kind: "element", tagName: "SPAN", attributes: { "data-cfemail": encoded } },
    { kind: "element", tagName: "INPUT", value: "billing@example.com" }
  ]);

  const { scanner, runtime, requests } = createScanner({ document });
  const result = await scanner.execute();

  assert.equal(result.status, "ok");
  assert.deepEqual(requests, [], "a populated non-root page must not be fetched");
  assert.equal(runtime.messages.length, 2, "partial and final reports are expected");
  assert.equal(runtime.messages[0].done, false);
  assert.equal(runtime.messages[1].done, true);
  assert.ok(runtime.messages.every((message) => message.scanId === "scan-1"));

  const emails = runtime.messages[1].emails;
  for (const expected of [
    "sales@example.com", "press@example.com", "hello@example.com",
    "team@example.com", "cf@example.com", "billing@example.com"
  ]) {
    assert.ok(emails.includes(expected), `missing ${expected} in ${emails.join(", ")}`);
  }
});

test("augments a root page with bounded, unauthenticated same-origin requests", async () => {
  const html = "<html><body><p>contact@example.com</p></body></html>";
  const parsed = createFakeDocument([{ kind: "text", value: "contact@example.com" }]);
  const domParser = createDomParser(new Map([[html, parsed]]));
  const location = createLocation({ href: "https://example.com/", pathname: "/" });
  const document = createFakeDocument([
    { kind: "element", tagName: "A", attributes: { href: "/contact-us?lang=en" } },
    { kind: "element", tagName: "A", attributes: { href: "https://other.test/contact" } },
    { kind: "element", tagName: "A", attributes: { href: "mailto:spam@example.com" } }
  ]);

  let active = 0;
  let peak = 0;
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, options });
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return {
      ok: true,
      url,
      headers: createHeaders({ "content-type": "text/html" }),
      text: async () => html
    };
  };

  const { scanner, runtime } = createScanner({ document, domParser, location, fetchImpl });
  await scanner.execute();

  assert.ok(requested.length > 0 && requested.length <= config.MAX_CONTACT_URLS);
  assert.ok(peak <= config.MAX_CONCURRENT_FETCHES, `peak concurrency was ${peak}`);
  assert.ok(requested.every(({ url }) => url.startsWith("https://example.com/")));
  assert.ok(requested.every(({ options }) => options.credentials === "omit"));
  assert.ok(requested.some(({ url }) => url.includes("/contact-us")));
  assert.equal(requested[0].options.signal instanceof AbortSignal, true);
  assert.ok(runtime.messages.at(-1).emails.includes("contact@example.com"));
  assert.equal(runtime.messages.at(-1).done, true);
});

test("rejects cross-origin redirects and oversized HTML payloads", async () => {
  const html = "<html><body>ignored@example.com</body></html>";
  let parseCount = 0;
  const domParser = {
    parseFromString(payload) {
      parseCount += 1;
      return createFakeDocument([{ kind: "text", value: payload }]);
    }
  };
  const document = createFakeDocument();
  const location = createLocation({ href: "https://example.com/", pathname: "/" });
  const fetchImpl = async () => ({
    ok: true,
    url: "https://attacker.test/contact",
    headers: createHeaders({ "content-type": "text/html", "content-length": "999999999" }),
    text: async () => html
  });

  const { scanner, runtime } = createScanner({ document, domParser, location, fetchImpl });
  await scanner.execute();

  assert.equal(parseCount, 0);
  assert.deepEqual(runtime.messages.at(-1).emails, []);
});

test("stops reading an oversized streamed response before parsing", async () => {
  let parseCount = 0;
  let cancelled = false;
  const domParser = {
    parseFromString() {
      parseCount += 1;
      return createFakeDocument();
    }
  };
  const chunk = new TextEncoder().encode("x".repeat(64));
  const fetchImpl = async () => ({
    ok: true,
    url: "https://example.com/contact",
    headers: createHeaders({ "content-type": "text/html" }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) {
              return { done: true, value: undefined };
            }
            sent = true;
            return { done: false, value: chunk };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {}
        };
      }
    }
  });

  const { scanner, runtime } = createScanner({
    config: { ...config, MAX_HTML_LENGTH: 32 },
    document: createFakeDocument(),
    domParser,
    fetchImpl,
    location: createLocation({ href: "https://example.com/", pathname: "/" })
  });
  await scanner.execute();

  assert.equal(cancelled, true);
  assert.equal(parseCount, 0);
  assert.deepEqual(runtime.messages.at(-1).emails, []);
});

test("stopping a scan aborts in-flight requests and reports cancellation", async () => {
  const document = createFakeDocument();
  const location = createLocation({ href: "https://example.com/", pathname: "/" });
  let aborted = 0;
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      aborted += 1;
      reject(new Error("aborted"));
    });
  });

  const { scanner, runtime } = createScanner({ document, location, fetchImpl });
  const pending = scanner.execute();
  scanner.requestStop();
  const result = await pending;

  assert.equal(result.status, "cancelled");
  assert.ok(aborted > 0, "in-flight fetches must be aborted");
  assert.equal(runtime.messages.at(-1).status, "cancelled");
  assert.equal(runtime.messages.at(-1).done, true);
});

test("caps collected results at the configured hard limit", async () => {
  const entries = [];
  for (let index = 0; index < config.MAX_RESULT_COUNT + 20; index += 1) {
    entries.push({ kind: "text", value: `user${index}@example.com` });
  }
  const { scanner, runtime } = createScanner({ document: createFakeDocument(entries) });
  await scanner.execute();

  assert.equal(runtime.messages.at(-1).emails.length, config.MAX_RESULT_COUNT);
});
