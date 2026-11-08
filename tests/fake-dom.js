/**
 * Minimal synthetic DOM for scanner tests. Accessing innerHTML or innerText
 * throws on purpose: the production scanner must never use either property.
 */
"use strict";

function createFakeDocument(entries = []) {
  const textNodes = [];
  const elements = [];
  const anchors = [];

  for (const entry of entries) {
    if (entry.kind === "text") {
      textNodes.push({
        nodeValue: entry.value,
        parentElement: { tagName: entry.parentTag || "P" }
      });
      continue;
    }

    const attributes = Object.entries(entry.attributes || {}).map(([name, value]) => ({ name, value }));
    const element = {
      tagName: entry.tagName || "DIV",
      attributes,
      value: entry.value || "",
      getAttribute(name) {
        return attributes.find((attribute) => attribute.name === name)?.value ?? null;
      }
    };
    Object.defineProperty(element, "innerHTML", {
      get() { throw new Error("innerHTML must not be read"); }
    });
    Object.defineProperty(element, "innerText", {
      get() { throw new Error("innerText must not be read"); }
    });

    elements.push(element);
    if (element.tagName === "A") {
      anchors.push(element);
    }
  }

  return {
    body: {},
    documentElement: {},
    createTreeWalker(_root, whatToShow) {
      if (whatToShow !== 0x4) {
        throw new Error("scanner must request SHOW_TEXT nodes");
      }
      let index = 0;
      return {
        nextNode() {
          return index < textNodes.length ? textNodes[index++] : null;
        }
      };
    },
    querySelectorAll(selector) {
      if (selector === "*") {
        return elements;
      }
      if (selector === "a[href]") {
        return anchors;
      }
      return [];
    }
  };
}

function createDomParser(documents) {
  return {
    parseFromString(html) {
      if (!documents.has(html)) {
        throw new Error("unexpected HTML payload");
      }
      return documents.get(html);
    }
  };
}

function createHeaders(values = {}) {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    }
  };
}

module.exports = { createDomParser, createFakeDocument, createHeaders };
