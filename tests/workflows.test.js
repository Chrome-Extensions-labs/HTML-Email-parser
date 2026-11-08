"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const workflowsDir = join(__dirname, "..", ".github", "workflows");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(join(workflowsDir, name), "utf8") }));

/** Extracts an indented top-level YAML block, if present. */
function topLevelBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) {
    return null;
  }
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("#")) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}

test("repository has workflow definitions to validate", () => {
  assert.ok(workflows.length >= 5);
});

test("workflow-level concurrency only uses supported contexts", () => {
  for (const { name, source } of workflows) {
    const block = topLevelBlock(source, "concurrency");
    if (!block) {
      continue;
    }
    const expressions = [...block.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)]
      .map((match) => match[1]);
    for (const expression of expressions) {
      // Only the leading identifier of a dotted path is a context name.
      const contexts = [...expression.matchAll(/(?:^|[^\w.])([a-z][a-z0-9_]*)\./g)]
        .map((match) => match[1]);
      for (const context of contexts) {
        assert.ok(
          ["github", "inputs", "vars"].includes(context),
          `${name}: top-level concurrency cannot reference '${context}'`
        );
      }
    }
  }
});

test("every workflow declares explicit permissions", () => {
  for (const { name, source } of workflows) {
    assert.match(source, /^permissions:/m, `${name} must declare permissions`);
  }
});

test("third-party actions are pinned to immutable commit SHAs", () => {
  for (const { name, source } of workflows) {
    const references = [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    assert.ok(references.length > 0, `${name} has no action references`);
    for (const reference of references) {
      assert.match(
        reference,
        /@[0-9a-f]{40}$/,
        `${name}: ${reference} must be pinned to a 40-character commit SHA`
      );
    }
  }
});
