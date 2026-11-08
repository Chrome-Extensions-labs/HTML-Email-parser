"""Unit tests for the pure helpers of scripts.trigger_action."""

import unittest

from scripts import trigger_action as review


class FileStub:
    def __init__(self, filename, patch=None):
        self.filename = filename
        self.patch = patch


def make_event(files=("popup.js",), sha="a" * 40):
    return review.Event(
        context="Commit Message: refactor",
        diff="+ const value = 1;",
        author="maintainer",
        labels=(),
        dedup_key="commit:abcdef1",
        changed_files=files,
        head_sha=sha,
    )


class ConfigTests(unittest.TestCase):
    def test_requires_all_secrets(self):
        with self.assertRaises(ValueError):
            review.Config.from_env({"GITHUB_TOKEN": "token"})

    def test_parses_allowed_users(self):
        config = review.Config.from_env({
            "GITHUB_TOKEN": "token",
            "GH_MODELS_TOKEN": "model",
            "REPOSITORY": "owner/repo",
            "EVENT_NAME": "push",
            "ALLOWED_USER": " Alice ,BOB, ,",
            "COMMIT_SHA": "a" * 40,
        })
        self.assertEqual(config.allowed_users, frozenset({"alice", "bob"}))
        self.assertEqual(config.event_name, "push")


class DiffTests(unittest.TestCase):
    def test_collects_patches_and_truncates(self):
        diff, changed = review.diff_from_files(
            [FileStub("popup.js", "+a" * 40), FileStub("README.md", "+b" * 40)],
            limit=60,
        )
        self.assertEqual(changed, ["popup.js"])
        self.assertIn("[Diff truncated...]", diff)
        prefix = diff.split("[Diff truncated...]")[0].rstrip("\n")
        self.assertLessEqual(len(prefix), 60)

    def test_tolerates_binary_files_and_empty_names(self):
        diff, changed = review.diff_from_files(
            [FileStub("icons/icon128.png", None), FileStub("", "unused")],
            limit=100,
        )
        self.assertEqual(changed, ["icons/icon128.png"])
        self.assertIn("Patch:\n\n", diff)


class RoleTests(unittest.TestCase):
    def test_explicit_label_wins(self):
        self.assertEqual(review.select_role(["unknown", "PERF"]), "perf")

    def test_detection_uses_paths_before_keywords(self):
        self.assertEqual(
            review.detect_change_type([".github/workflows/lint.yml"], ""),
            "ci",
        )
        self.assertEqual(
            review.detect_change_type(["README.md"], "documentation update"),
            "docs",
        )
        self.assertEqual(
            review.detect_change_type(["src/app.py"], "exposed api_key"),
            "security",
        )
        self.assertEqual(review.detect_change_type(["unknown.xyz"], ""), "general")


class ResultTests(unittest.TestCase):
    def test_model_response_accepts_markdown_fences(self):
        parsed = review.parse_model_response(
            '```json\n{"issue_title": "[LOW] Docs"}\n```'
        )
        self.assertEqual(parsed["issue_title"], "[LOW] Docs")

    def test_model_response_rejects_non_objects(self):
        with self.assertRaises(review.ModelError):
            review.parse_model_response("[1, 2]")

    def test_permalink_encodes_untrusted_paths(self):
        link = review.build_permalink(
            "owner/repo", "a" * 40, "src/a b?c.md", 12
        )
        self.assertIn("src/a%20b%3Fc.md#L12", link)

    def test_permalink_rejects_non_hex_sha(self):
        self.assertEqual(
            review.build_permalink("owner/repo", "not-a-sha", "popup.js", 1),
            "",
        )

    def test_normalise_result_filters_labels_and_hallucinated_files(self):
        result = review.normalise_result(
            {
                "issue_title": "[HIGH] Review",
                "severity": "high",
                "issue_body": "## Permalink\nPUT_PERMALINK_HERE",
                "labels": ["bug", "made-up-label", "security"],
                "affected_file": "does/not/exist.js",
                "affected_line": -5,
                "summary": "Summary",
            },
            make_event(),
            "owner/repo",
        )
        self.assertEqual(result.affected_file, "")
        self.assertEqual(result.affected_line, 1)
        self.assertEqual(result.severity, "high")
        self.assertIn("severity: high", result.labels)
        self.assertIn("ai-generated", result.labels)
        self.assertIn("bug", result.labels)
        self.assertNotIn("made-up-label", result.labels)
        self.assertIn("_No specific file identified_", result.body)

    def test_normalise_result_uses_real_changed_files(self):
        result = review.normalise_result(
            {"affected_file": "popup.js", "affected_line": 42},
            make_event(),
            "owner/repo",
        )
        self.assertEqual(result.affected_file, "popup.js")
        self.assertIn("#L42", result.body)


if __name__ == "__main__":
    unittest.main()
