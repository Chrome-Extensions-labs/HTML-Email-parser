# Contributing

Thank you for taking an interest in the project. Bug reports, extraction edge cases, documentation fixes and focused pull requests are all welcome.

## Setup

The extension itself needs no build step. To work on the code and run the checks:

```bash
git clone https://github.com/Chrome-Extensions-labs/HTML-Email-parser.git
cd HTML-Email-parser
npm ci
npm run check
```

Node.js 22 and Python 3.11 are required for the development tooling only. Load the repository root as an unpacked extension from `chrome://extensions` to test changes in a browser.

## Code conventions

- Extension files are classic scripts loaded without a bundler. Keep them free of imports, build-time syntax and new runtime dependencies.
- Each script is wrapped in an IIFE with `"use strict"` and exposes a single frozen namespace on `globalThis`; the CommonJS footer exists only so Node tests can import the module.
- `shared/email-utils.js` must stay DOM-free. Entity decoding and validation are pure functions, which keeps them fast and testable.
- Use `textContent` and `dataset` for dynamic values. Never build markup from page-derived strings.
- Keep regex quantifiers bounded and cap any input whose size is controlled by a web page.
- Comments and documentation are written in professional English and explain intent or constraints rather than restating the code.
- Runtime limits belong in `shared/config.js`; do not duplicate magic numbers across the popup and the scanner.

## Tests

Add a unit test whenever extraction rules, state transitions or scanner behaviour change:

- JavaScript tests live in `tests/*.test.js` and use `node:test`.
- Python helper tests live in `tests/test_*.py` and use `unittest`.
- Run `npm run check` before opening a pull request. The CI runs the same command.

For scanner changes, also verify manually on a page with a visible address, an obfuscated address, a `mailto:` link and a site whose contact information is only available on a secondary route.

## Permissions and privacy

The extension deliberately has no `host_permissions`. Any change that adds a permission, a new network destination, cookie-bearing requests or persistent storage needs an explicit justification in the pull request description. Contact-page probing must remain same-origin, unauthenticated and bounded.

## Pull requests

1. Fork the repository and create a topic branch.
2. Make the change with tests and, for user-visible changes, update `README.md` and `manifest.json`.
3. Run `npm run check` and a manual browser smoke test.
4. Open a pull request and complete the checklist in the template.

Small, reviewable changes are merged faster than broad rewrites. If you are unsure about an approach, open an issue first so we can agree on the design before code is written.
