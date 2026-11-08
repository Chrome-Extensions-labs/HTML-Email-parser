"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../shared/email-utils.js");

test("extracts plain addresses, normalises case and deduplicates", () => {
  const found = [...utils.extractFromText("Write to Sales@Example.com or sales@example.com")];
  assert.deepEqual(found, ["sales@example.com"]);
});

test("decodes numeric entities and full-width separators without a DOM", () => {
  assert.deepEqual([...utils.extractFromText("info&#64;example&#46;com")], ["info@example.com"]);
  assert.deepEqual([...utils.extractFromText("sales＠example．com")], ["sales@example.com"]);
  assert.equal(typeof globalThis.document, "undefined");
});

test("recovers bracketed, parenthesised and spelled-out obfuscation", () => {
  const cases = [
    ["hello [at] company [dot] io", "hello@company.io"],
    ["marketing (at) startup (dot) co.uk", "marketing@startup.co.uk"],
    ["sales at example dot com", "sales@example.com"],
    ["info [at] sub [dot] example [dot] com", "info@sub.example.com"]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual([...utils.extractFromText(input)], [expected], input);
  }
});

test("does not invent addresses from ordinary prose containing URLs", () => {
  assert.deepEqual([...utils.extractFromText("Contact us at www.example.com")], []);
});

test("recovers JavaScript string concatenation", () => {
  const source = 'var address = "sales" + "@" + "example" + "." + "com";';
  assert.deepEqual([...utils.extractFromText(source)], ["sales@example.com"]);
});

test("preserves plus addressing and strips mailto URL parameters", () => {
  assert.deepEqual([...utils.extractFromText("user+tag@example.com")], ["user+tag@example.com"]);
  assert.equal(
    utils.sanitizeCandidate("mailto:sales%40example.com?subject=Hello"),
    "sales@example.com"
  );
});

test("rejects asset URLs, hashed identifiers and malformed addresses", () => {
  assert.deepEqual(
    [...utils.extractFromText("hero@2x.png bundle.a1b2c3d4e5f6@hash.js")],
    []
  );
  assert.equal(utils.isValidEmail("bad..dots@example.com"), false);
  assert.equal(utils.isValidEmail("foo@www.example.com"), false);
  assert.equal(utils.isValidEmail("foo?subject=x@example.com"), false);
  assert.equal(utils.isValidEmail("a@b"), false);
});

test("decodes Cloudflare email obfuscation and rejects malformed payloads", () => {
  let encoded = "2a";
  for (const character of "info@example.com") {
    encoded += (character.charCodeAt(0) ^ 0x2a).toString(16).padStart(2, "0");
  }
  assert.equal(utils.decodeCloudflareEmail(encoded), "info@example.com");
  assert.equal(utils.decodeCloudflareEmail("zz112233"), null);
  assert.equal(utils.decodeCloudflareEmail("2a4344c"), null);
  assert.equal(utils.decodeCloudflareEmail(null), null);
});

test("sorts by business priority with stable alphabetical tie-breaking", () => {
  const sorted = utils.sortByBusinessPriority([
    "zebra@example.com",
    "info@example.com",
    "ads@example.com",
    "zebra@example.com",
    "not-an-email"
  ]);
  assert.deepEqual(sorted, ["ads@example.com", "info@example.com", "zebra@example.com"]);
});

test("bounds pathological input instead of scanning unbounded strings", () => {
  const huge = "a".repeat(200_000) + "sales@example.com";
  assert.deepEqual([...utils.extractFromText(huge)], []);
  assert.equal(utils.sanitizeCandidate("x".repeat(5_000) + "sales@example.com"), null);
});
