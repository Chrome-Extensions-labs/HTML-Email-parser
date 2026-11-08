"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function createElement(tagName) {
  const children = [];
  const element = {
    tagName: tagName.toUpperCase(),
    className: "",
    textContent: "",
    href: "",
    disabled: false,
    dataset: {},
    attributes: {},
    children,
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    append(...nodes) {
      children.push(...nodes);
    },
    replaceChildren(...nodes) {
      children.length = 0;
      children.push(...nodes);
    }
  };
  return element;
}

globalThis.document = {
  createElement,
  createDocumentFragment: () => createElement("fragment")
};
require("../shared/config.js");
require("../shared/email-utils.js");
require("../popup/render.js");
require("../popup/state.js");

function createHarness() {
  const elements = {
    list: createElement("ul"),
    title: createElement("h1"),
    meta: createElement("p"),
    summary: createElement("p"),
    refreshButton: createElement("button"),
    copyAllButton: createElement("button")
  };
  return { elements, view: globalThis.PopupRender.createView(elements) };
}

function rowsOf(list) {
  const fragment = list.children[0];
  return fragment ? fragment.children : [];
}

test("renders addresses as text nodes and safe mailto links", () => {
  const { elements, view } = createHarness();
  const state = globalThis.PopupState.createState();
  globalThis.PopupState.setTab(state, {
    id: 1,
    url: "https://example.com/contact",
    title: "Contact"
  });
  globalThis.PopupState.setEmails(state, ["sales@example.com"]);

  view.render(state);

  assert.equal(elements.title.textContent, "Contact");
  assert.equal(elements.meta.textContent, "example.com");
  assert.match(elements.summary.textContent, /1 address found/);

  const [row] = rowsOf(elements.list);
  const [address, actions] = row.children;
  assert.equal(address.textContent, "sales@example.com");
  const [copyButton, mailLink] = actions.children;
  assert.equal(copyButton.dataset.action, "copy");
  assert.equal(copyButton.dataset.email, "sales@example.com");
  assert.equal(mailLink.href, "mailto:sales@example.com");
  assert.equal(mailLink.attributes.target, undefined);
  assert.equal(elements.copyAllButton.disabled, false);
});

test("shows a loading status and disables refresh while scanning", () => {
  const { elements, view } = createHarness();
  const state = globalThis.PopupState.createState();
  globalThis.PopupState.setLoading(state, true);

  view.render(state);

  assert.equal(elements.refreshButton.disabled, true);
  assert.equal(elements.list.attributes["aria-busy"], "true");
  assert.match(elements.list.children[0].textContent, /Searching/);
  assert.equal(elements.copyAllButton.disabled, true);
});

test("keeps partial results visible during augmentation", () => {
  const { elements, view } = createHarness();
  const state = globalThis.PopupState.createState();
  globalThis.PopupState.setEmails(state, ["contact@example.com"]);
  globalThis.PopupState.setLoading(state, true);

  view.render(state);

  assert.equal(rowsOf(elements.list).length, 1);
  assert.match(elements.summary.textContent, /Checking contact pages/);
});

test("renders an error state without a list", () => {
  const { elements, view } = createHarness();
  const state = globalThis.PopupState.createState();
  globalThis.PopupState.setError(state, "The scan did not finish in time.");

  view.render(state);

  assert.match(elements.summary.textContent, /did not finish/);
  assert.match(elements.list.children[0].textContent, /did not finish/);
  assert.equal(elements.list.children[0].className, "status status-error");
});
