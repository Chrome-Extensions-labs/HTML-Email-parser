## Description

<!-- What changed and why. Keep it factual. -->

## Related issue(s)

Closes #

## Type of change

- [ ] Bug fix
- [ ] New capability within the existing scanning/UI scope
- [ ] Refactor or performance improvement
- [ ] Documentation or repository tooling
- [ ] CI/CD workflow change
- [ ] Manifest/permission change (requires an explicit justification below)

## Verification

- [ ] `npm run check` passes locally
- [ ] `npm run package` produces a loadable archive
- [ ] Loaded unpacked in Chrome and verified the popup on at least one real page
- [ ] Added or updated tests for changed extraction/state logic
- [ ] Re-tested obfuscated and `mailto:` patterns if `shared/email-utils.js` changed

## Checklist

- [ ] Comments and documentation are written in professional English
- [ ] No new runtime dependency or extension permission was introduced without justification
- [ ] `README.md` reflects any user-visible change
- [ ] `manifest.json` version was bumped for a user-visible change
- [ ] Self-reviewed the diff for unvalidated input, unbounded loops and DOM allocations
