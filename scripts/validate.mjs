#!/usr/bin/env node
/**
 * Validates the unpacked extension without loading it in Chrome.
 *
 * Besides JSON and path checks, this guards two properties that are easy to
 * regress during a refactor: the absence of broad host permissions and a
 * complete one-to-one match between the script tags, the injected file list and
 * the files that actually ship.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const errors = [];
const read = (file) => readFileSync(join(root, file), "utf8");
const exists = (file) => existsSync(join(root, file));
const fail = (condition, message) => {
  if (!condition) {
    errors.push(message);
  }
};
const listFiles = (directory) => {
  if (!exists(directory)) {
    return [];
  }
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `${directory}/${name}`)
    .filter((file) => statSync(join(root, file)).isFile());
};

const manifest = JSON.parse(read("manifest.json"));

fail(manifest.manifest_version === 3, "manifest_version must be 3");
fail(/^\d+\.\d+\.\d+$/.test(manifest.version || ""), "version must be x.y.z");
fail(
  typeof manifest.minimum_chrome_version === "string",
  "minimum_chrome_version must be declared"
);
fail(
  manifest.host_permissions === undefined,
  "host_permissions must stay empty; activeTab grants access only on user invocation"
);

const allowedPermissions = new Set([
  "activeTab", "scripting", "clipboardWrite", "tabs", "storage"
]);
for (const permission of manifest.permissions || []) {
  fail(
    allowedPermissions.has(permission),
    `unexpected permission: ${permission}`
  );
}

const referenced = [
  manifest.action?.default_popup,
  manifest.action?.default_icon?.["128"],
  manifest.icons?.["128"],
  manifest.background?.service_worker
].filter(Boolean);

for (const file of referenced) {
  fail(exists(file), `manifest references a missing file: ${file}`);
}

const popupHtml = read(manifest.action.default_popup);
fail(
  !/<script(?![^>]*\bsrc=)[^>]*>/i.test(popupHtml),
  "inline scripts are forbidden by the MV3 extension page CSP"
);

const scriptSources = Array.from(
  popupHtml.matchAll(/<script\s+src="([^"]+)"/gi),
  (match) => match[1]
);
for (const source of scriptSources) {
  fail(exists(source), `popup references a missing script: ${source}`);
}

const popupSource = read("popup.js");
const injectionBlock = popupSource.match(/files:\s*\[([\s\S]*?)\]/);
fail(Boolean(injectionBlock), "popup.js must declare the injected file list");

const injected = injectionBlock
  ? Array.from(injectionBlock[1].matchAll(/"([^"]+\.js)"/g), (match) => match[1])
  : [];
for (const file of injected) {
  fail(exists(file), `injected file is missing: ${file}`);
}

const shippedScripts = new Set([
  "content.js",
  "popup.js",
  ...listFiles("shared"),
  ...listFiles("content"),
  ...listFiles("popup")
]);
const referencedScripts = new Set([...scriptSources, ...injected]);

for (const file of shippedScripts) {
  fail(
    referencedScripts.has(file) || file === "content.js" || file === "popup.js",
    `runtime script is never loaded: ${file}`
  );
}

if (errors.length > 0) {
  for (const message of errors) {
    console.error(`  ✗ ${message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Manifest and ${shippedScripts.size} runtime scripts validated.`);
}
