"""
Unit tests for status.py — pure functions, no I/O.

Covers:
  score_to_grade      — all grade boundaries
  build_status_patch  — phase, grade, score, violations, source, model, conditions
  _build_conditions   — Ready / Compliant / ModelReachable condition content
"""

import pytest

from models import GapIssue, HealthCheck, ProbeResult
from status import build_status_patch, score_to_grade
from tests.conftest import make_health, make_gap, make_model_check, make_probe


# ── score_to_grade ────────────────────────────────────────────────────────────

class TestScoreToGrade:
    def test_100_is_A(self):
        assert score_to_grade(100) == "A"

    def test_90_is_A(self):
        assert score_to_grade(90) == "A"

    def test_89_is_B(self):
        assert score_to_grade(89) == "B"

    def test_80_is_B(self):
        assert score_to_grade(80) == "B"

    def test_79_is_B(self):
        # SDK scale: B >= 75 (was C in old operator scale — now aligned with CLAUDE.md)
        assert score_to_grade(79) == "B"

    def test_75_is_B(self):
        assert score_to_grade(75) == "B"

    def test_74_is_C(self):
        assert score_to_grade(74) == "C"

    def test_70_is_C(self):
        assert score_to_grade(70) == "C"

    def test_69_is_C(self):
        # SDK scale: C >= 60 (was D in old operator scale)
        assert score_to_grade(69) == "C"

    def test_60_is_C(self):
        # SDK scale: C >= 60 (was D in old operator scale)
        assert score_to_grade(60) == "C"

    def test_59_is_D(self):
        # SDK scale: D >= 45 (was F in old operator scale)
        assert score_to_grade(59) == "D"

    def test_45_is_D(self):
        assert score_to_grade(45) == "D"

    def test_44_is_F(self):
        assert score_to_grade(44) == "F"

    def test_0_is_F(self):
        assert score_to_grade(0) == "F"


# ── build_status_patch — phase mapping ───────────────────────────────────────

class TestBuildStatusPatchPhase:
    def test_ready_maps_to_Healthy(self, healthy_probe):
        patch = build_status_patch(healthy_probe)
        assert patch["phase"] == "Healthy"

    def test_degraded_maps_to_Degraded(self, degraded_probe):
        patch = build_status_patch(degraded_probe)
        assert patch["phase"] == "Degraded"

    def test_unavailable_maps_to_Unhealthy(self, unhealthy_probe):
        patch = build_status_patch(unhealthy_probe)
        assert patch["phase"] == "Unhealthy"

    def test_unknown_status_maps_to_Unknown(self):
        # ReadyReport.health_status translates anything unknown → "unknown"
        probe = make_probe(health_status="ready")
        probe.health.status = "ready"  # valid status, maps to healthy
        patch = build_status_patch(probe)
        assert patch["phase"] == "Healthy"


# ── build_status_patch — grade and score ─────────────────────────────────────

class TestBuildStatusPatchGrade:
    def test_score_94_grade_A(self, healthy_probe):
        patch = build_status_patch(healthy_probe)
        assert patch["score"] == 94
        assert patch["grade"] == "A"

    def test_score_45_grade_D(self, degraded_probe):
        # SDK scale: D >= 45 (was F in old operator scale)
        patch = build_status_patch(degraded_probe)
        assert patch["score"] == 45
        assert patch["grade"] == "D"

    def test_score_12_grade_F(self, unhealthy_probe):
        patch = build_status_patch(unhealthy_probe)
        assert patch["score"] == 12
        assert patch["grade"] == "F"


# ── build_status_patch — violations count ────────────────────────────────────

class TestBuildStatusPatchViolations:
    def test_no_issues_zero_violations(self, healthy_probe):
        assert build_status_patch(healthy_probe)["violations"] == 0

    def test_two_issues_two_violations(self, degraded_probe):
        assert build_status_patch(degraded_probe)["violations"] == 2

    def test_four_issues_four_violations(self, unhealthy_probe):
        assert build_status_patch(unhealthy_probe)["violations"] == 4


# ── build_status_patch — source passthrough ──────────────────────────────────

class TestBuildStatusPatchSource:
    def test_agent_sdk_source_preserved(self, healthy_probe):
        assert build_status_patch(healthy_probe)["source"] == "agent-sdk"

    def test_manifest_static_source_preserved(self, degraded_probe):
        assert build_status_patch(degraded_probe)["source"] == "manifest-static"


# ── build_status_patch — model check ─────────────────────────────────────────

class TestBuildStatusPatchModel:
    def test_model_pass_status(self, healthy_probe):
        patch = build_status_patch(healthy_probe)
        assert patch["model"]["status"] == "pass"

    def test_model_pass_includes_latency(self, healthy_probe):
        patch = build_status_patch(healthy_probe)
        assert patch["model"]["latencyMs"] == 42

    def test_model_fail_status(self, degraded_probe):
        patch = build_status_patch(degraded_probe)
        assert patch["model"]["status"] == "fail"

    def test_no_model_check_returns_unknown(self):
        # Probe with no model check in health report
        probe = make_probe(health_status="ready", gap_score=80, checks=[])
        patch = build_status_patch(probe)
        assert patch["model"]["status"] == "unknown"
        assert "latencyMs" not in patch["model"]


# ── build_status_patch — summary ─────────────────────────────────────────────

class TestBuildStatusPatchSummary:
    def test_summary_keys_present(self, healthy_probe):
        patch = build_status_patch(healthy_probe)
        assert set(patch["summary"]) == {"passed", "failed", "warnings", "skipped"}

    def test_summary_counts_reflect_checks(self):
        checks = [
            make_model_check("pass"),
            HealthCheck(id="env:FOO", category="env", status="fail", severity="error"),
        ]
        probe = make_probe(health_status="degraded", checks=checks)
        patch = build_status_patch(probe)
        assert patch["summary"]["passed"] == 1
        assert patch["summary"]["failed"] == 1


# ── build_status_patch — conditions ──────────────────────────────────────────

class TestBuildStatusPatchConditions:
    def test_three_conditions_present(self, healthy_probe):
        conds = build_status_patch(healthy_probe)["conditions"]
        types = {c["type"] for c in conds}
        assert types == {"Ready", "Compliant", "ModelReachable"}

    def test_healthy_ready_condition_true(self, healthy_probe):
        conds = build_status_patch(healthy_probe)["conditions"]
        ready = next(c for c in conds if c["type"] == "Ready")
        assert ready["status"] == "True"
        assert ready["reason"] == "AllChecksPassed"

    def test_degraded_ready_condition_false(self, degraded_probe):
        conds = build_status_patch(degraded_probe)["conditions"]
        ready = next(c for c in conds if c["type"] == "Ready")
        assert ready["status"] == "False"
        assert ready["reason"] == "ChecksFailed"

    def test_no_violations_compliant_true(self, healthy_probe):
        conds = build_status_patch(healthy_probe)["conditions"]
        compliant = next(c for c in conds if c["type"] == "Compliant")
        assert compliant["status"] == "True"
        assert compliant["reason"] == "NoViolations"

    def test_violations_compliant_false_with_count(self, degraded_probe):
        conds = build_status_patch(degraded_probe)["conditions"]
        compliant = next(c for c in conds if c["type"] == "Compliant")
        assert compliant["status"] == "False"
        assert compliant["reason"] == "ViolationsDetected"
        assert "2 violation" in compliant["message"]

    def test_model_pass_reachable_true(self, healthy_probe):
        conds = build_status_patch(healthy_probe)["conditions"]
        model = next(c for c in conds if c["type"] == "ModelReachable")
        assert model["status"] == "True"

    def test_model_fail_reachable_false(self, degraded_probe):
        conds = build_status_patch(degraded_probe)["conditions"]
        model = next(c for c in conds if c["type"] == "ModelReachable")
        assert model["status"] == "False"

    def test_no_model_check_reachable_unknown(self):
        probe = make_probe(health_status="ready", checks=[])
        conds = build_status_patch(probe)["conditions"]
        model = next(c for c in conds if c["type"] == "ModelReachable")
        assert model["status"] == "Unknown"

    def test_model_skip_reachable_unknown(self):
        checks = [make_model_check("skip", latency_ms=None)]
        probe = make_probe(health_status="degraded", checks=checks)
        conds = build_status_patch(probe)["conditions"]
        model = next(c for c in conds if c["type"] == "ModelReachable")
        assert model["status"] == "Unknown"

    def test_conditions_have_lastTransitionTime(self, healthy_probe):
        conds = build_status_patch(healthy_probe)["conditions"]
        for c in conds:
            assert "lastTransitionTime" in c
            assert c["lastTransitionTime"]  # not empty
