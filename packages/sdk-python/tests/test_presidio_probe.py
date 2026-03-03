"""
Unit tests for PresidioProbe.

All tests mock AnalyzerEngine — no spaCy download required in CI.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def manifest_with_hygiene():
    """Manifest with memory.hygiene.piiScrubFields defined."""
    return {
        "apiVersion": "agentspec.io/v1",
        "kind": "AgentSpec",
        "metadata": {"name": "test-agent", "version": "1.0.0"},
        "spec": {
            "model": {"provider": "openai", "id": "gpt-4o"},
            "memory": {
                "hygiene": {
                    "piiScrubFields": ["ssn", "credit_card"],
                    "redactBeforeLog": True,
                }
            },
        },
    }


@pytest.fixture
def manifest_no_hygiene():
    """Manifest without any memory hygiene config."""
    return {
        "apiVersion": "agentspec.io/v1",
        "kind": "AgentSpec",
        "metadata": {"name": "bare-agent", "version": "1.0.0"},
        "spec": {
            "model": {"provider": "openai", "id": "gpt-4o"},
        },
    }


@pytest.fixture
def mock_analyzer():
    """
    Returns a mock AnalyzerEngine that yields no results by default.
    Use mock_analyzer.analyze.return_value = [...] to customise per test.
    """
    analyzer = MagicMock()
    analyzer.analyze.return_value = []
    return analyzer


def _make_recognizer_result(entity_type: str, score: float, start: int, end: int):
    """Build a minimal fake RecognizerResult-like object."""
    r = MagicMock()
    r.entity_type = entity_type
    r.score = score
    r.start = start
    r.end = end
    return r


# ── Helper: build PresidioProbe without installing presidio ───────────────────

def _make_probe(manifest: dict, sidecar_url: str | None = None,
                analyzer=None, score_threshold: float = 0.7):
    """Import PresidioProbe with presidio_analyzer mocked if not installed."""
    # Ensure presidio_analyzer is importable (mock it if absent)
    fake_presidio = MagicMock()
    fake_presidio.AnalyzerEngine = MagicMock
    modules_to_patch = {}
    if "presidio_analyzer" not in sys.modules:
        modules_to_patch["presidio_analyzer"] = fake_presidio

    with patch.dict("sys.modules", modules_to_patch):
        from agentspec.presidio_probe import PresidioProbe
        probe = PresidioProbe(
            manifest=manifest,
            sidecar_url=sidecar_url,
            analyzer=analyzer,
            score_threshold=score_threshold,
        )
    return probe


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestScanTextsNoPii:
    def test_returns_passed_when_no_hits(self, manifest_no_hygiene, mock_analyzer):
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_texts(["Hello world", "Nothing suspicious here"])
        assert result.passed is True
        assert result.hits == []

    def test_scanned_items_count(self, manifest_no_hygiene, mock_analyzer):
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_texts(["a", "b", "c"])
        assert result.scanned_items == 3


class TestScanTextsWithPii:
    def test_ssn_hit_returns_failed(self, manifest_no_hygiene, mock_analyzer):
        ssn_text = "My SSN is 123-45-6789"
        mock_analyzer.analyze.return_value = [
            _make_recognizer_result("US_SSN", 0.85, 10, 21)
        ]
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_texts([ssn_text])
        assert result.passed is False
        assert len(result.hits) == 1
        hit = result.hits[0]
        assert hit.entity_type == "US_SSN"
        assert hit.score == pytest.approx(0.85)
        assert hit.start == 10
        assert hit.end == 21

    def test_hit_excerpt_is_redacted(self, manifest_no_hygiene, mock_analyzer):
        text = "My SSN is 123-45-6789"
        mock_analyzer.analyze.return_value = [
            _make_recognizer_result("US_SSN", 0.85, 10, 21)
        ]
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_texts([text])
        # excerpt must not expose the raw PII value
        assert result.hits[0].text_excerpt != "123-45-6789"

    def test_score_below_threshold_not_reported(self, manifest_no_hygiene, mock_analyzer):
        """Hits with score < threshold are silently ignored."""
        mock_analyzer.analyze.return_value = [
            _make_recognizer_result("EMAIL_ADDRESS", 0.50, 0, 10)
        ]
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer, score_threshold=0.7)
        result = probe.scan_texts(["test@example.com"])
        assert result.passed is True
        assert result.hits == []


class TestScanLogFile:
    def test_reads_lines_and_delegates_to_scan_texts(
        self, tmp_path, manifest_no_hygiene, mock_analyzer
    ):
        log = tmp_path / "agent.log"
        log.write_text("line one\nline two\nline three\n")
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_log_file(str(log))
        assert result.scanned_items == 3

    def test_clean_log_passes(self, tmp_path, manifest_no_hygiene, mock_analyzer):
        log = tmp_path / "agent.log"
        log.write_text("2024-01-01 INFO agent started\n2024-01-01 INFO done\n")
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_log_file(str(log))
        assert result.passed is True

    def test_log_with_pii_fails(self, tmp_path, manifest_no_hygiene, mock_analyzer):
        log = tmp_path / "agent.log"
        log.write_text("INFO: user ssn=123-45-6789\n")
        mock_analyzer.analyze.return_value = [
            _make_recognizer_result("US_SSN", 0.9, 15, 26)
        ]
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_log_file(str(log))
        assert result.passed is False

    def test_scan_log_file_proves_obs03(self, tmp_path, manifest_no_hygiene, mock_analyzer):
        log = tmp_path / "agent.log"
        log.write_text("clean log line\n")
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_log_file(str(log))
        assert result.rule_ids == ["OBS-03"]


class TestEntityResolution:
    def test_entities_from_manifest_fields(self, manifest_with_hygiene, mock_analyzer):
        probe = _make_probe(manifest_with_hygiene, analyzer=mock_analyzer)
        entities = probe._get_entities()
        assert "US_SSN" in entities
        assert "CREDIT_CARD" in entities

    def test_default_entities_when_no_hygiene_config(self, manifest_no_hygiene, mock_analyzer):
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        entities = probe._get_entities()
        assert set(entities) == {"US_SSN", "CREDIT_CARD", "EMAIL_ADDRESS", "PHONE_NUMBER"}

    def test_scan_texts_proves_sec_llm06_and_mem01(self, manifest_no_hygiene, mock_analyzer):
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_texts(["no pii here"])
        assert "SEC-LLM-06" in result.rule_ids
        assert "MEM-01" in result.rule_ids

    def test_entities_checked_present_in_result(self, manifest_no_hygiene, mock_analyzer):
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer)
        result = probe.scan_texts(["text"])
        assert isinstance(result.entities_checked, list)
        assert len(result.entities_checked) > 0


class TestSubmitProof:
    def test_submit_proof_posts_to_sidecar(self, manifest_no_hygiene, mock_analyzer):
        """submit_proof POSTs to /proof/rule/{ruleId} for each rule in result."""
        import httpx

        probe = _make_probe(
            manifest_no_hygiene,
            analyzer=mock_analyzer,
            sidecar_url="http://localhost:4001",
        )
        result = probe.scan_texts(["clean text"])
        assert result.passed is True

        mock_response = MagicMock()
        mock_response.status_code = 201

        with patch("agentspec.presidio_probe.httpx.post", return_value=mock_response) as mock_post:
            success = probe.submit_proof(result, verified_by="presidio")

        assert success is True
        assert mock_post.call_count == len(result.rule_ids)
        # Verify the URLs called
        called_urls = [call.args[0] for call in mock_post.call_args_list]
        for rule_id in result.rule_ids:
            assert f"http://localhost:4001/proof/rule/{rule_id}" in called_urls

    def test_submit_proof_skipped_when_no_url(self, manifest_no_hygiene, mock_analyzer):
        """submit_proof returns False and makes no HTTP call when sidecar_url is None."""
        probe = _make_probe(manifest_no_hygiene, analyzer=mock_analyzer, sidecar_url=None)
        result = probe.scan_texts(["clean text"])
        # No sidecar URL → no request, returns False
        success = probe.submit_proof(result)
        assert success is False

    def test_submit_proof_skipped_when_result_failed(self, manifest_no_hygiene, mock_analyzer):
        """submit_proof should not POST proof when scan failed (PII found)."""
        mock_analyzer.analyze.return_value = [
            _make_recognizer_result("US_SSN", 0.9, 0, 11)
        ]
        probe = _make_probe(
            manifest_no_hygiene,
            analyzer=mock_analyzer,
            sidecar_url="http://localhost:4001",
        )
        result = probe.scan_texts(["123-45-6789"])
        assert result.passed is False

        with patch("httpx.post") as mock_post:
            success = probe.submit_proof(result)
            mock_post.assert_not_called()
        assert success is False


class TestImportGuard:
    def test_import_error_without_presidio(self, manifest_no_hygiene):
        """PresidioProbe raises ImportError with install hint when presidio is missing."""
        # Remove presidio_analyzer from sys.modules if present, then block it
        with patch.dict("sys.modules", {"presidio_analyzer": None}):
            # Force reimport of presidio_probe to trigger the import guard
            if "agentspec.presidio_probe" in sys.modules:
                del sys.modules["agentspec.presidio_probe"]
            from agentspec.presidio_probe import PresidioProbe

            with pytest.raises(ImportError, match="pip install agentspec\\[presidio\\]"):
                PresidioProbe(manifest=manifest_no_hygiene)


class TestFromYaml:
    def test_from_yaml_loads_manifest(self, tmp_path, manifest_no_hygiene, mock_analyzer):
        """PresidioProbe.from_yaml() reads agent.yaml correctly."""
        manifest_file = tmp_path / "agent.yaml"
        manifest_file.write_text(yaml.dump(manifest_no_hygiene))

        with patch.dict("sys.modules", {}):
            fake_presidio = MagicMock()
            fake_presidio.AnalyzerEngine = MagicMock
            with patch.dict("sys.modules", {"presidio_analyzer": fake_presidio}):
                if "agentspec.presidio_probe" in sys.modules:
                    del sys.modules["agentspec.presidio_probe"]
                from agentspec.presidio_probe import PresidioProbe
                probe = PresidioProbe.from_yaml(str(manifest_file), analyzer=mock_analyzer)

        result = probe.scan_texts(["hello"])
        assert result.passed is True
