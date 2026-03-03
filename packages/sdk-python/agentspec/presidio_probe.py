"""
PresidioProbe — scan texts or log files for unredacted PII via Microsoft Presidio.

Proves three AgentSpec audit rules:
  - SEC-LLM-06  (PII scrub in model outputs)
  - MEM-01      (PII scrub in memory)
  - OBS-03      (log redaction)

Usage:
    from agentspec.presidio_probe import PresidioProbe

    probe = PresidioProbe.from_yaml("agent.yaml", sidecar_url="http://localhost:4001")
    result = probe.scan_log_file("/var/log/agent/agent.log")
    if result.passed:
        probe.submit_proof(result, verified_by="presidio")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from .manifest import load_manifest

# ── Constants ──────────────────────────────────────────────────────────────────

FIELD_TO_ENTITIES: dict[str, str] = {
    "ssn": "US_SSN",
    "credit_card": "CREDIT_CARD",
    "email": "EMAIL_ADDRESS",
    "phone": "PHONE_NUMBER",
    "ip_address": "IP_ADDRESS",
    "passport": "US_PASSPORT",
    "driver_license": "US_DRIVER_LICENSE",
    "iban": "IBAN_CODE",
    "person": "PERSON",
    "location": "LOCATION",
    "date": "DATE_TIME",
    "url": "URL",
}

_DEFAULT_ENTITIES: list[str] = [
    "US_SSN",
    "CREDIT_CARD",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
]

# ── Dataclasses ────────────────────────────────────────────────────────────────


@dataclass
class PiiHit:
    """A single PII finding from a Presidio scan."""

    entity_type: str    # e.g. "US_SSN", "CREDIT_CARD"
    score: float        # Presidio confidence score (0.0 – 1.0)
    start: int          # character offset (inclusive)
    end: int            # character offset (exclusive)
    text_excerpt: str   # redacted excerpt, e.g. "***-**-6789"


@dataclass
class ProbeScanResult:
    """Result of a PresidioProbe scan."""

    rule_ids: list[str]         # rules this scan proves, e.g. ["SEC-LLM-06", "MEM-01"]
    passed: bool                # True = no PII found above threshold
    hits: list[PiiHit]          # empty list when passed is True
    scanned_items: int          # number of texts or log lines scanned
    entities_checked: list[str] # Presidio entity types that were checked


# ── PresidioProbe ─────────────────────────────────────────────────────────────


class PresidioProbe:
    """
    Scan agent outputs, memory contents, or log files for unredacted PII.

    Parameters
    ----------
    manifest:
        Raw manifest dict (as returned by load_manifest()).
    sidecar_url:
        Optional URL of the AgentSpec sidecar (e.g. "http://localhost:4001").
        Required for submit_proof() to do anything.
    analyzer:
        Optional pre-built AnalyzerEngine. Injected for testing so that the
        real Presidio (with spaCy) is never needed in CI.
    score_threshold:
        Minimum Presidio confidence score to report as a PII hit. Default 0.7.
    """

    def __init__(
        self,
        manifest: dict[str, Any],
        sidecar_url: str | None = None,
        analyzer: Any | None = None,
        score_threshold: float = 0.7,
    ) -> None:
        self._manifest = manifest
        self._sidecar_url = sidecar_url
        self._score_threshold = score_threshold
        self._entities: list[str] = self._get_entities()

        if analyzer is not None:
            self._analyzer = analyzer
        else:
            # Import guard — raises ImportError with install hint if not installed
            try:
                from presidio_analyzer import AnalyzerEngine  # type: ignore[import]
            except (ImportError, TypeError) as exc:
                raise ImportError(
                    "presidio_analyzer is not installed. "
                    "Install presidio: pip install agentspec[presidio] "
                    "&& python -m spacy download en_core_web_lg"
                ) from exc
            self._analyzer = AnalyzerEngine()

    @classmethod
    def from_yaml(cls, manifest_path: str, **kwargs: Any) -> "PresidioProbe":
        """Create a PresidioProbe by loading manifest from a YAML file path."""
        manifest = load_manifest(manifest_path)
        return cls(manifest=manifest, **kwargs)

    # ── Public API ─────────────────────────────────────────────────────────────

    def scan_texts(self, texts: list[str]) -> ProbeScanResult:
        """
        Scan a list of strings for PII.

        Proves SEC-LLM-06 (PII scrub in model outputs) and MEM-01 (PII scrub
        in memory).
        """
        hits: list[PiiHit] = []

        for text in texts:
            results = self._analyzer.analyze(
                text=text,
                entities=self._entities,
                language="en",
            )
            for r in results:
                if r.score < self._score_threshold:
                    continue
                hits.append(PiiHit(
                    entity_type=r.entity_type,
                    score=r.score,
                    start=r.start,
                    end=r.end,
                    text_excerpt=self._redact(text, r.start, r.end),
                ))

        return ProbeScanResult(
            rule_ids=["SEC-LLM-06", "MEM-01"],
            passed=len(hits) == 0,
            hits=hits,
            scanned_items=len(texts),
            entities_checked=self._entities,
        )

    def scan_log_file(self, log_path: str) -> ProbeScanResult:
        """
        Scan a log file line by line for unredacted PII.

        Proves OBS-03 (log redaction).
        """
        with open(log_path, "r", encoding="utf-8") as fh:
            lines = [line.rstrip("\n") for line in fh]

        # Reuse scan_texts logic, then override rule_ids
        interim = self.scan_texts(lines)
        return ProbeScanResult(
            rule_ids=["OBS-03"],
            passed=interim.passed,
            hits=interim.hits,
            scanned_items=interim.scanned_items,
            entities_checked=interim.entities_checked,
        )

    def submit_proof(
        self,
        result: ProbeScanResult,
        verified_by: str = "presidio",
    ) -> bool:
        """
        POST proof records to the sidecar if the scan passed.

        Returns True if all submissions succeeded, False otherwise.
        Does nothing (returns False) when sidecar_url is not set or scan failed.
        """
        if self._sidecar_url is None or not result.passed:
            return False

        all_ok = True
        for rule_id in result.rule_ids:
            try:
                resp = httpx.post(
                    f"{self._sidecar_url}/proof/rule/{rule_id}",
                    json={
                        "verifiedBy": verified_by,
                        "method": (
                            f"Presidio scan: {result.scanned_items} item(s) checked "
                            f"for {', '.join(result.entities_checked)} — no PII found"
                        ),
                    },
                    timeout=10.0,
                )
                if resp.status_code >= 400:
                    all_ok = False
            except Exception:
                all_ok = False

        return all_ok

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _get_entities(self) -> list[str]:
        """
        Extract entity list from manifest spec.memory.hygiene.piiScrubFields.
        Falls back to four default entities when not configured.
        """
        fields: list[str] = (
            self._manifest
            .get("spec", {})
            .get("memory", {})
            .get("hygiene", {})
            .get("piiScrubFields", [])
        )
        if not fields:
            return list(_DEFAULT_ENTITIES)

        entities: list[str] = []
        for f in fields:
            mapped = self._map_field_to_entity(f)
            if mapped is not None:
                entities.append(mapped)

        return entities if entities else list(_DEFAULT_ENTITIES)

    def _map_field_to_entity(self, field_name: str) -> str | None:
        """Map a manifest field name to a Presidio entity type. None = unknown field."""
        return FIELD_TO_ENTITIES.get(field_name.lower())

    @staticmethod
    def _redact(text: str, start: int, end: int) -> str:
        """Return a redacted excerpt with stars replacing the sensitive span."""
        length = end - start
        return "*" * length


if __name__ == "__main__":
    import sys
    from agentspec.__main__ import main
    sys.exit(main())
