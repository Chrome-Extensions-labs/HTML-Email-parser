"""Generate a review issue and an optional PR comment from a GitHub diff.

Invoked by .github/workflows/ai-issue.yml as ``python -m scripts.trigger_action``.
The module has no import-time side effects or third-party imports, so the pure
helpers can be unit tested without credentials or network access.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Iterable, Mapping
from urllib.parse import quote

from .review_prompts import (
    BASE_INSTRUCTIONS,
    LABEL_TO_ROLE,
    PROMPT_ROLES,
    SEVERITY_GUIDE,
)

MODEL_NAME = "Llama-3.3-70B-Instruct"
ENDPOINT = "https://models.inference.ai.azure.com/chat/completions"

DIFF_LIMITS = {"push": 10_000, "pull_request": 80_000}
MIN_DIFF_LENGTH = 50
MAX_TITLE_LENGTH = 200
MAX_BODY_LENGTH = 20_000
MAX_SUMMARY_LENGTH = 2_000

SEVERITY_LABELS = {
    "critical": "severity: critical",
    "high": "severity: high",
    "elevated": "severity: elevated",
    "medium": "severity: medium",
    "moderate": "severity: moderate",
    "low": "severity: low",
    "informational": "severity: informational",
}

KNOWN_LABELS = frozenset({
    *SEVERITY_LABELS.values(),
    "bug", "enhancement", "documentation", "security", "performance",
    "refactor", "dependencies", "python", "javascript", "actions",
    "ai-generated", "needs triage", "duplicate", "good first issue",
    "help wanted", "wontfix",
})


class ModelError(RuntimeError):
    """Raised when the inference endpoint cannot return a usable JSON object."""


@dataclass(frozen=True)
class Config:
    """Validated environment for one workflow run."""

    gh_token: str
    model_token: str
    repo_name: str
    event_name: str
    commit_sha: str = ""
    pr_number: str = ""
    allowed_users: frozenset[str] = frozenset()

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if environ is None else environ
        required = ("GITHUB_TOKEN", "GH_MODELS_TOKEN", "REPOSITORY", "EVENT_NAME")
        missing = [key for key in required if not env.get(key)]
        if missing:
            raise ValueError(f"missing environment variables: {', '.join(missing)}")

        users = frozenset(
            name.strip().lower()
            for name in env.get("ALLOWED_USER", "").split(",")
            if name.strip()
        )
        return cls(
            gh_token=env["GITHUB_TOKEN"],
            model_token=env["GH_MODELS_TOKEN"],
            repo_name=env["REPOSITORY"],
            event_name=env["EVENT_NAME"],
            commit_sha=env.get("COMMIT_SHA", ""),
            pr_number=env.get("PR_NUMBER", ""),
            allowed_users=users,
        )


@dataclass(frozen=True)
class Event:
    """Normalised view of the push or pull request that triggered the run."""

    context: str
    diff: str
    author: str
    labels: tuple[str, ...]
    dedup_key: str
    changed_files: tuple[str, ...]
    head_sha: str
    pr: Any = None


@dataclass(frozen=True)
class ReviewResult:
    """Validated model output, safe to publish to GitHub."""

    title: str
    body: str
    severity: str
    labels: tuple[str, ...]
    affected_file: str
    affected_line: int
    summary: str


def clean_text(value: Any, limit: int, default: str = "") -> str:
    """Coerce untrusted model output into bounded plain text."""
    if not isinstance(value, str):
        return default
    cleaned = value.replace("\r", "").strip()
    return cleaned[:limit]


def diff_from_files(files: Iterable[Any], limit: int) -> tuple[str, list[str]]:
    """Collect file patches up to a hard character budget."""
    parts: list[str] = []
    changed: list[str] = []
    consumed = 0

    for file in files:
        filename = str(getattr(file, "filename", "") or "").strip()
        if not filename:
            continue
        changed.append(filename)

        patch = str(getattr(file, "patch", None) or "")
        block = f"File: {filename}\nPatch:\n{patch}\n\n"
        remaining = limit - consumed
        if remaining <= 0:
            break
        if len(block) > remaining:
            parts.append(block[:remaining])
            parts.append("\n[Diff truncated...]")
            consumed = limit
            break
        parts.append(block)
        consumed += len(block)

    return "".join(parts), changed


def collect_event(repo: Any, config: Config) -> Event | None:
    """Read event metadata through the GitHub API or return None to skip it."""
    limit = DIFF_LIMITS.get(config.event_name)
    if limit is None:
        return None

    if config.event_name == "push":
        commit = repo.get_commit(config.commit_sha)
        if len(commit.parents) > 1 or not commit.author:
            return None
        author = str(commit.author.login).strip().lower()
        if author not in config.allowed_users:
            return None

        message = commit.commit.message or ""
        match = re.search(r"\(#(\d+)\)", message)
        dedup_key = f"PR #{match.group(1)}" if match else f"commit:{config.commit_sha[:7]}"
        context = f"Commit Message: {message}"
        labels = tuple(item.lower() for item in re.findall(r"\[(.*?)\]", message))
        diff, changed = diff_from_files(commit.files, limit)
        return Event(context, diff, author, labels, dedup_key, tuple(changed), config.commit_sha)

    if not config.pr_number.isdigit():
        print("PR_NUMBER is missing or invalid. Skipping.")
        return None

    pr = repo.get_pull(int(config.pr_number))
    author = str(pr.user.login).strip().lower()
    if author not in config.allowed_users:
        return None

    context = f"PR Title: {pr.title or ''}\nPR Body: {pr.body or ''}"
    labels = tuple(str(label.name).lower() for label in pr.labels)
    diff, changed = diff_from_files(pr.get_files(), limit)
    return Event(
        context,
        diff,
        author,
        labels,
        f"PR #{config.pr_number}",
        tuple(changed),
        str(pr.head.sha),
        pr,
    )


def select_role(labels: Iterable[str]) -> str | None:
    """Resolve the first explicit label to a prompt role."""
    for label in labels:
        role = LABEL_TO_ROLE.get(str(label).strip().lower())
        if role:
            return role
    return None


def contains_any(values: Iterable[str], keywords: Iterable[str]) -> bool:
    return any(keyword in value for value in values for keyword in keywords)


def detect_change_type(files: Iterable[str], diff: str, context: str = "") -> str:
    """Infer a review role from changed paths and diff keywords."""
    names = [str(name).lower() for name in files]
    text = f"{diff}\n{context}".lower()

    if contains_any(names, ("security", "auth", ".env", "secret")) or contains_any(
        [text],
        ("secret", "token", "password", "api_key", "credential", "private_key",
         "vulnerability", "cve-", "injection", "xss", "csrf"),
    ):
        return "security"
    if contains_any(names, ("requirements", "package.json", "package-lock", "pipfile",
                            "poetry.lock", "cargo.toml", "go.sum", "gemfile",
                            "dependabot", "renovate")):
        return "deps"
    if contains_any(names, (".github/workflows/", "jenkinsfile", ".gitlab-ci",
                            ".circleci", "dockerfile", "docker-compose")):
        return "ci"
    if names and all(contains_any([name], ("readme", "contributing", "changelog",
                                           "license", "docs/", ".md", ".rst")) for name in names):
        return "docs"
    if contains_any(names, (".html", ".css", ".jsx", ".tsx", ".vue", ".svelte",
                            "frontend/", "public/", "static/", "assets/")) or contains_any(
        [text], ("classname", "style=", "onclick", "addeventlistener",
                 "document.get", "innerhtml", "appendchild"),
    ):
        return "frontend"
    if contains_any(names, (".py", ".go", ".java", ".rb", ".rs", ".php",
                            "api/", "server/", "backend/", "lib/", "src/")):
        return "backend"
    if contains_any(names, (".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
                            ".json", ".env")):
        return "config"
    return "general"


def build_prompt(event: Event, role_key: str) -> str:
    """Assemble the role-specific review prompt from bounded inputs."""
    instruction = PROMPT_ROLES.get(role_key, PROMPT_ROLES["general"])
    return (
        f"{instruction}\n\n"
        "Do not invent problems that are not present in the diff. Base every "
        "finding strictly on the supplied changes.\n"
        f"{SEVERITY_GUIDE}\n"
        f"Context: {event.context[:2_000]}\n"
        f"Changed files: {', '.join(event.changed_files)[:4_000]}\n"
        f"Changes: {event.diff}\n"
        f"{BASE_INSTRUCTIONS}"
    )


def parse_model_response(raw: Any) -> dict[str, Any]:
    """Strip optional markdown fences and parse the JSON object."""
    if not isinstance(raw, str):
        raise ModelError("model returned no text content")
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ModelError("model response is not a JSON object")
    return parsed


def call_model(prompt: str, config: Config, retries: int = 3, delay: float = 5.0) -> dict[str, Any]:
    """Call the hosted model with bounded exponential backoff."""
    import requests  # Imported lazily so the pure helpers need no dependencies.

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.model_token}",
    }
    payload = {
        "messages": [
            {
                "role": "system",
                "content": "You are a professional software auditor. Return valid JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
        "model": MODEL_NAME,
        "temperature": 0.1,
    }

    for attempt in range(retries):
        try:
            response = requests.post(ENDPOINT, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return parse_model_response(content)
        except (
            KeyError, IndexError, TypeError, ValueError,
            ModelError, requests.RequestException,
        ) as error:
            print(f"Model attempt {attempt + 1} failed: {error}")
            if attempt < retries - 1:
                time.sleep(delay * (2 ** attempt))

    raise ModelError("all model attempts failed")


def build_permalink(repo_name: str, sha: str, filename: str, line: int) -> str:
    """Build a blob permalink with a percent-encoded path."""
    if not repo_name or not sha or not filename or not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        return ""
    safe_path = quote(filename, safe="/-._~")
    return f"https://github.com/{repo_name}/blob/{sha}/{safe_path}#L{line}"


def normalise_result(raw: dict[str, Any], event: Event, repo_name: str) -> ReviewResult:
    """Validate every field before it can reach an issue or PR comment."""
    severity = str(raw.get("severity", "medium")).strip().lower()
    if severity not in SEVERITY_LABELS:
        severity = "medium"

    title = clean_text(raw.get("issue_title"), MAX_TITLE_LENGTH, "Automated change review")
    body = clean_text(
        raw.get("issue_body"),
        MAX_BODY_LENGTH,
        "## Problem\nNot provided.\n\n## Permalink\nPUT_PERMALINK_HERE",
    )
    summary = clean_text(raw.get("summary"), MAX_SUMMARY_LENGTH)

    requested_labels = raw.get("labels")
    labels = {
        str(label).strip().lower()
        for label in requested_labels
        if isinstance(label, str) and str(label).strip().lower() in KNOWN_LABELS
    } if isinstance(requested_labels, list) else set()
    labels.add(SEVERITY_LABELS[severity])
    labels.add("ai-generated")

    # The model may propose a path that does not exist in the diff; only real
    # changed files are accepted, preventing broken or misleading permalinks.
    affected_file = str(raw.get("affected_file", "") or "").strip().lstrip("./")
    if affected_file not in event.changed_files:
        affected_file = ""

    try:
        affected_line = max(1, min(100_000, int(raw.get("affected_line", 1))))
    except (TypeError, ValueError):
        affected_line = 1

    permalink = build_permalink(repo_name, event.head_sha, affected_file, affected_line)
    body = body.replace("PUT_PERMALINK_HERE", permalink or "_No specific file identified_")

    return ReviewResult(
        title=title or "Automated change review",
        body=body,
        severity=severity,
        labels=tuple(sorted(labels)),
        affected_file=affected_file,
        affected_line=affected_line,
        summary=summary,
    )


def issue_exists(gh: Any, repo: Any, repo_name: str, dedup_key: str) -> bool:
    """Check for an existing analysis of this commit or pull request."""
    query = f'repo:{repo_name} is:issue "{dedup_key}" in:body'
    try:
        return gh.search_issues(query).totalCount > 0
    except Exception:  # The search API can be rate limited; degrade gracefully.
        return any(
            dedup_key in (issue.body or "")
            for issue in repo.get_issues(state="all")[:200]
        )


def was_already_closed(gh: Any, repo_name: str, title_keyword: str) -> bool:
    """Avoid reopening a discussion that was already resolved."""
    keyword = re.sub(r'["\r\n]', " ", title_keyword)[:80].strip()
    if not keyword:
        return False
    query = f'repo:{repo_name} is:issue is:closed "{keyword}" in:title'
    try:
        return gh.search_issues(query).totalCount > 0
    except Exception:
        return False


def build_issue_body(result: ReviewResult, event: Event, role_key: str) -> str:
    footer = f"\n\n---\n*Generated from {event.dedup_key} | Review role: `{role_key}`*"
    return result.body + footer


def build_pr_comment(result: ReviewResult, role_key: str, issue_number: int) -> str:
    return (
        "### AI Analysis Summary\n\n"
        f"{result.summary}\n\n"
        f"**Severity:** `{result.severity.upper()}` | **Role:** `{role_key}`\n\n"
        f"Full details: #{issue_number}"
    )


def main(environ: Mapping[str, str] | None = None) -> int:
    """Run one analysis. Returns a process exit code; never raises on API errors."""
    try:
        config = Config.from_env(environ)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    if config.event_name not in DIFF_LIMITS:
        return 0

    try:
        from github import Auth, Github, GithubException
    except ImportError:
        print("PyGithub is required to run the analysis", file=sys.stderr)
        return 2

    gh = Github(auth=Auth.Token(config.gh_token))
    repo = gh.get_repo(config.repo_name)

    try:
        event = collect_event(repo, config)
        if event is None:
            return 0
        if len(event.diff.strip()) < MIN_DIFF_LENGTH:
            print("Diff too small to analyze. Skipping.")
            return 0
        if issue_exists(gh, repo, config.repo_name, event.dedup_key):
            print(f"Issue for {event.dedup_key} already exists. Skipping.")
            return 0
    except GithubException as error:
        print(f"GitHub API call failed: {error}", file=sys.stderr)
        return 0

    role_key = select_role(event.labels) or detect_change_type(
        event.changed_files, event.diff, event.context
    )
    if not event.labels:
        print(f"Auto-detected review role: {role_key}")

    try:
        raw = call_model(build_prompt(event, role_key), config)
    except ModelError as error:
        print(f"{error}. Exiting without creating an issue.")
        return 0

    result = normalise_result(raw, event, config.repo_name)
    if was_already_closed(gh, config.repo_name, result.title[:40]):
        print("A similar closed issue exists. Skipping.")
        return 0

    try:
        issue = repo.create_issue(
            title=result.title,
            body=build_issue_body(result, event, role_key),
            labels=list(result.labels),
        )
        print(f"Created issue #{issue.number}: {issue.title}")

        if event.pr and result.summary:
            event.pr.create_issue_comment(build_pr_comment(result, role_key, issue.number))
            print(f"Posted a summary comment to PR #{event.pr.number}")
    except GithubException as error:
        print(f"GitHub API call failed: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
