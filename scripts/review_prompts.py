"""Prompt data for the automated change review workflow.

Kept separate from the workflow logic because the text is configuration, not
behaviour, and it changes on a different cadence than the GitHub API code.
"""

SEVERITY_GUIDE = """
Use the following severity scale and select the level that matches the actual impact.

CRITICAL — Production-breaking changes, exposed secrets, injection flaws, broken authentication, data loss or service outages.
HIGH — Significant changes to core logic, public interfaces, permissions, access control or data schemas.
ELEVATED — Substantial new features, cross-cutting refactors, external integrations or changes to error handling.
MEDIUM — New helpers, CI/CD changes, runtime configuration changes or meaningful new files.
MODERATE — Small behavioural changes, validation improvements, diagnostics or metadata updates.
LOW — Documentation, cosmetic UI changes, formatting and renames without behavioural impact.
INFORMATIONAL — Typos, whitespace and comment rewording only.

Do not default to LOW or INFORMATIONAL. Evaluate the real scope of the change.
""".strip()

BASE_INSTRUCTIONS = """
Return only a raw JSON object with no markdown formatting. The JSON must have these exact keys:

"issue_title": string — starts with a severity prefix such as [CRITICAL], [HIGH], [ELEVATED], [MEDIUM], [MODERATE], [LOW] or [INFO],
"severity": string — one of critical, high, elevated, medium, moderate, low, informational,
"issue_body": string — must include these sections:
  ## Problem
  (description with exact file paths and line numbers where known)

  ## Code Reference
  (the relevant code snippet)

  ## Suggested Fix
  (concrete steps, or "No action required" for informational changes)

  ## Permalink
  (placeholder PUT_PERMALINK_HERE, replaced automatically)

"labels": list of strings — standard GitHub labels plus the severity level,
"affected_file": string — the most relevant filename from the diff, or "" if unknown,
"affected_line": integer — approximate line number, or 1 if unknown,
"summary": string — a two or three sentence plain-English summary for the PR comment.

The issue_title, issue_body and summary must be written entirely in English.
""".strip()

PROMPT_ROLES = {
    "security": (
        "Act as a Strict Security Auditor. Perform a deep security audit "
        "(OWASP Top 10, CWE patterns). Find real vulnerabilities with exact "
        "file and line references. Check for exposed secrets, injection vectors, "
        "broken authentication, insecure deserialization and misconfigurations."
    ),
    "review": (
        "Act as a Strict Code Reviewer. Analyze code quality using SOLID, DRY "
        "and KISS principles. Point to exact lines that violate them and evaluate "
        "naming, error handling and separation of concerns."
    ),
    "qa": (
        "Act as a QA Engineer. Identify edge cases, missing test coverage, "
        "untested error paths and potential regressions. Reference the functions "
        "that need tests."
    ),
    "perf": (
        "Act as a Performance Expert. Analyze algorithmic complexity, O(n^2) "
        "patterns, unnecessary allocations, blocking I/O and missed caching "
        "opportunities. Reference exact lines."
    ),
    "pm": (
        "Act as a Product Manager. Generate user-facing release notes with clear "
        "impact descriptions, focused on what changed for the end user."
    ),
    "deps": (
        "Act as a Security and Dependency Auditor. Analyze changed dependencies "
        "for known vulnerabilities, licence compatibility, size impact and "
        "maintenance status."
    ),
    "arch": (
        "Act as a Software Architect. Review separation of concerns, coupling, "
        "layer boundaries and anti-patterns such as magic numbers or circular "
        "dependencies."
    ),
    "ci": (
        "Act as a DevOps/CI Engineer. Review pipeline changes for correctness, "
        "token permissions, secret exposure, caching, parallelism and race "
        "conditions."
    ),
    "docs": (
        "Act as a Technical Writer. Review documentation for completeness, "
        "accuracy, valid links and correct code examples."
    ),
    "frontend": (
        "Act as a Frontend Engineer. Review UI changes for accessibility, "
        "responsive design, render performance, XSS risks in DOM manipulation "
        "and browser compatibility."
    ),
    "backend": (
        "Act as a Senior Backend Engineer. Review correctness, error handling, "
        "input validation, resource management, concurrency safety and API "
        "contract compliance."
    ),
    "config": (
        "Act as a Configuration and Infrastructure Reviewer. Analyze config "
        "changes for correctness, security implications, environment consistency "
        "and breaking changes for existing deployments."
    ),
    "general": (
        "Act as a Senior Software Engineer reviewing a colleague's changes. "
        "Assess what changed, the risks or bugs introduced, code quality and the "
        "overall scope of the change."
    ),
}

LABEL_TO_ROLE = {
    "sec": "security", "security": "security", "audit": "security",
    "review": "review", "refactor": "review", "code-review": "review",
    "qa": "qa", "test": "qa", "testing": "qa",
    "perf": "perf", "performance": "perf", "optimize": "perf",
    "pm": "pm", "release": "pm", "product": "pm",
    "deps": "deps", "dependencies": "deps", "dep": "deps",
    "arch": "arch", "architecture": "arch",
    "ci": "ci", "devops": "ci", "pipeline": "ci", "workflow": "ci",
    "docs": "docs", "doc": "docs", "documentation": "docs",
    "frontend": "frontend", "ui": "frontend", "ux": "frontend", "css": "frontend",
    "backend": "backend", "api": "backend", "server": "backend",
    "config": "config", "infra": "config", "infrastructure": "config",
}
