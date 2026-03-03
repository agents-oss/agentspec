"""
Unit tests for agentspec.__main__.main() CLI entry point.

All tests use the main(argv=[...]) API — no subprocess spawning, no real Presidio.
PresidioProbe is fully mocked via patch.
"""

from __future__ import annotations

import json
import sys
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest
import yaml


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_probe_result(passed: bool = True, hits=None, rule_ids=None):
    """Build a minimal mock ProbeScanResult."""
    from agentspec.presidio_probe import ProbeScanResult
    return ProbeScanResult(
        rule_ids=rule_ids or ["SEC-LLM-06", "MEM-01"],
        passed=passed,
        hits=hits or [],
        scanned_items=1,
        entities_checked=["US_SSN", "CREDIT_CARD"],
    )


def _run_main(argv: list[str]) -> int:
    """Import and call main() with argv; return exit code."""
    # Ensure a fresh import so module-level state doesn't bleed between tests
    if "agentspec.__main__" in sys.modules:
        del sys.modules["agentspec.__main__"]
    from agentspec.__main__ import main
    return main(argv)


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def manifest_file(tmp_path):
    """Write a minimal agent.yaml and return its path."""
    data = {
        "apiVersion": "agentspec.io/v1",
        "kind": "AgentSpec",
        "metadata": {"name": "test-agent", "version": "1.0.0"},
        "spec": {"model": {"provider": "openai", "id": "gpt-4o"}},
    }
    p = tmp_path / "agent.yaml"
    p.write_text(yaml.dump(data))
    return str(p)


@pytest.fixture
def log_file(tmp_path):
    """Write a minimal log file and return its path."""
    p = tmp_path / "agent.log"
    p.write_text("INFO: agent started\nINFO: done\n")
    return str(p)


@pytest.fixture
def mock_probe_class():
    """
    Patch PresidioProbe.from_yaml so tests never touch real Presidio.
    Yields the mock instance.
    """
    mock_instance = MagicMock()
    mock_instance.scan_texts.return_value = _make_probe_result(passed=True)
    mock_instance.scan_log_file.return_value = _make_probe_result(
        passed=True, rule_ids=["OBS-03"]
    )
    mock_instance.submit_proof.return_value = True

    with patch("agentspec.presidio_probe.PresidioProbe.from_yaml", return_value=mock_instance):
        yield mock_instance


# ── Argument validation ───────────────────────────────────────────────────────


class TestArgValidation:
    def test_submit_without_sidecar_url_returns_1(self, manifest_file, mock_probe_class, capsys):
        code = _run_main(["--manifest", manifest_file, "--log-file", "/tmp/x.log", "--submit"])
        assert code == 1
        captured = capsys.readouterr()
        assert "--submit requires --sidecar-url" in captured.err

    def test_missing_manifest_exits_nonzero(self, capsys):
        with pytest.raises(SystemExit) as exc_info:
            _run_main(["--text", "hello"])
        assert exc_info.value.code != 0

    def test_neither_text_nor_log_file_exits_nonzero(self, manifest_file, capsys):
        with pytest.raises(SystemExit) as exc_info:
            _run_main(["--manifest", manifest_file])
        assert exc_info.value.code != 0

    def test_text_and_log_file_are_mutually_exclusive(self, manifest_file, capsys):
        with pytest.raises(SystemExit) as exc_info:
            _run_main(["--manifest", manifest_file, "--text", "hi", "--log-file", "/tmp/x.log"])
        assert exc_info.value.code != 0


# ── Exit codes ────────────────────────────────────────────────────────────────


class TestExitCodes:
    def test_returns_0_when_no_pii_found(self, manifest_file, mock_probe_class):
        mock_probe_class.scan_texts.return_value = _make_probe_result(passed=True)
        code = _run_main(["--manifest", manifest_file, "--text", "clean text"])
        assert code == 0

    def test_returns_1_when_pii_found(self, manifest_file, mock_probe_class):
        from agentspec.presidio_probe import PiiHit
        mock_probe_class.scan_texts.return_value = _make_probe_result(
            passed=False,
            hits=[PiiHit(entity_type="US_SSN", score=0.9, start=0, end=11, text_excerpt="***")],
        )
        code = _run_main(["--manifest", manifest_file, "--text", "123-45-6789"])
        assert code == 1

    def test_returns_1_on_manifest_load_error(self, capsys):
        code = _run_main(["--manifest", "/no/such/file.yaml", "--text", "hello"])
        assert code == 1
        captured = capsys.readouterr()
        assert "ERROR" in captured.err


# ── Scan routing ──────────────────────────────────────────────────────────────


class TestScanRouting:
    def test_scan_texts_called_for_text_mode(self, manifest_file, mock_probe_class):
        _run_main(["--manifest", manifest_file, "--text", "hello", "--text", "world"])
        mock_probe_class.scan_texts.assert_called_once_with(["hello", "world"])
        mock_probe_class.scan_log_file.assert_not_called()

    def test_scan_log_file_called_for_log_mode(self, manifest_file, log_file, mock_probe_class):
        _run_main(["--manifest", manifest_file, "--log-file", log_file])
        mock_probe_class.scan_log_file.assert_called_once_with(log_file)
        mock_probe_class.scan_texts.assert_not_called()


# ── JSON output ───────────────────────────────────────────────────────────────


class TestJsonOutput:
    def test_json_flag_outputs_valid_json(self, manifest_file, mock_probe_class, capsys):
        _run_main(["--manifest", manifest_file, "--text", "clean", "--json"])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert "passed" in parsed
        assert "hits" in parsed
        assert "rule_ids" in parsed

    def test_json_flag_includes_scanned_items(self, manifest_file, mock_probe_class, capsys):
        _run_main(["--manifest", manifest_file, "--text", "clean", "--json"])
        captured = capsys.readouterr()
        parsed = json.loads(captured.out)
        assert "scanned_items" in parsed

    def test_human_readable_output_without_json_flag(self, manifest_file, mock_probe_class, capsys):
        _run_main(["--manifest", manifest_file, "--text", "clean"])
        captured = capsys.readouterr()
        assert "Presidio PII Probe" in captured.out
        assert "PASSED" in captured.out


# ── Proof submission ──────────────────────────────────────────────────────────


class TestProofSubmission:
    def test_submit_proof_called_on_pass(self, manifest_file, mock_probe_class, capsys):
        mock_probe_class.scan_texts.return_value = _make_probe_result(passed=True)
        _run_main([
            "--manifest", manifest_file,
            "--text", "clean",
            "--sidecar-url", "http://localhost:4001",
            "--submit",
        ])
        mock_probe_class.submit_proof.assert_called_once()

    def test_submit_proof_not_called_on_fail(self, manifest_file, mock_probe_class, capsys):
        from agentspec.presidio_probe import PiiHit
        mock_probe_class.scan_texts.return_value = _make_probe_result(
            passed=False,
            hits=[PiiHit(entity_type="US_SSN", score=0.9, start=0, end=3, text_excerpt="***")],
        )
        _run_main([
            "--manifest", manifest_file,
            "--text", "123",
            "--sidecar-url", "http://localhost:4001",
            "--submit",
        ])
        mock_probe_class.submit_proof.assert_not_called()

    def test_submit_proof_not_called_without_submit_flag(self, manifest_file, mock_probe_class):
        _run_main(["--manifest", manifest_file, "--text", "clean"])
        mock_probe_class.submit_proof.assert_not_called()
