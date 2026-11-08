"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

require("../shared/config.js");
require("../shared/email-utils.js");
require("../popup/state.js");

const root = join(__dirname, "..");
const PopupState = globalThis.PopupState;

test("setEmails validates, prioritises and caps untrusted input", () => {
  const state = PopupState.createState();
  const emails = PopupState.setEmails(state, [
    "info@example.com",
    "ads@example.com",
    "not-an-email",
    null,
    "info@example.com"
  ]);
  assert.deepEqual(emails, ["ads@example.com", "info@example.com"]);
});

test("setTab tolerates missing tab metadata", () => {
  const state = PopupState.createState();
  PopupState.setTab(state, { id: 7, url: "https://example.com/", title: "" });
  assert.equal(state.activeTabId, 7);
  assert.equal(state.tabTitle, "Email Finder");
});

test("applyCache only accepts entries with valid addresses", () => {
  const state = PopupState.createState();
  assert.equal(PopupState.applyCache(state, { emails: ["invalid"], savedAt: 10 }), false);
  assert.equal(
    PopupState.applyCache(state, { emails: ["sales@example.com"], savedAt: 10 }),
    true
  );
  assert.equal(state.source, "cache");
  assert.equal(state.lastUpdated, 10);
});

test("applyMessage transitions loading and surfaces scan failures", () => {
  const state = PopupState.createState();
  PopupState.setLoading(state, true);

  assert.deepEqual(
    PopupState.applyMessage(state, { emails: ["sales@example.com"], done: false }).done,
    false
  );
  assert.equal(state.loading, true);

  PopupState.applyMessage(state, { emails: ["sales@example.com"], done: true });
  assert.equal(state.loading, false);
  assert.equal(state.error, "");

  PopupState.applyMessage(state, { emails: [], done: true, status: "error" });
  assert.equal(state.loading, false);
  assert.match(state.error, /could not read/i);
});

test("manifest keeps least-privilege permissions and valid asset references", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "clipboardWrite", "scripting", "storage", "tabs"]
  );

  const popupHtml = readFileSync(join(root, manifest.action.default_popup), "utf8");
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(popupHtml), false);

  for (const match of popupHtml.matchAll(/<script\s+src="([^"]+)"/gi)) {
    assert.equal(existsSync(join(root, match[1])), true, match[1]);
  }
  for (const asset of [manifest.action.default_icon["128"], manifest.icons["128"]]) {
    assert.equal(existsSync(join(root, asset)), true, asset);
  }
});

test("popup injects exactly the runtime bundle declared by the repository", () => {
  const source = readFileSync(join(root, "popup.js"), "utf8");
  const block = source.match(/files:\s*\[([\s\S]*?)\]/);
  assert.ok(block);

  const injected = [...block[1].matchAll(/"([^"]+\.js)"/g)].map((match) => match[1]);
  assert.deepEqual(injected, [
    "shared/config.js",
    "shared/email-utils.js",
    "content/scanner.js",
    "content.js"
  ]);
  for (const file of injected) {
    assert.equal(existsSync(join(root, file)), true, file);
  }
});
