"""
Unit tests for webhook.py — MutatingWebhook pure business logic.

Tests cover pure functions only. The HTTP admission layer is handled by kopf's
native WebhookServer (configured in operator.py) — no Starlette/uvicorn here.

Coverage:
  - should_inject()            — annotation opt-in gate
  - is_sidecar_present()       — idempotency guard
  - build_sidecar_patch()      — JSON Patch construction
  - get_cr_name()              — AgentObservation CR naming
  - build_admission_response() — AdmissionReview envelope
  - _EXCLUDED_NAMESPACES       — module-level exclusion constant
"""

from __future__ import annotations

import base64
import importlib.util
import json
import pathlib

import pytest

# Load webhook.py without triggering any name conflict
_WEBHOOK_PATH = pathlib.Path(__file__).parent.parent / "webhook.py"
_spec = importlib.util.spec_from_file_location("agentspec_webhook", _WEBHOOK_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

should_inject = _mod.should_inject
is_sidecar_present = _mod.is_sidecar_present
build_sidecar_patch = _mod.build_sidecar_patch
get_cr_name = _mod.get_cr_name
build_admission_response = _mod.build_admission_response


# ── Helpers ───────────────────────────────────────────────────────────────────

def _pod_spec(containers: list[dict] | None = None) -> dict:
    """Minimal PodSpec with optional container list."""
    return {"containers": containers or [{"name": "agent", "image": "python:3.12-slim"}]}


# ── should_inject ─────────────────────────────────────────────────────────────

class TestShouldInject:
    def test_inject_true_annotation_returns_true(self):
        assert should_inject({"agentspec.io/inject": "true"}) is True

    def test_no_annotations_returns_false(self):
        assert should_inject({}) is False

    def test_inject_false_returns_false(self):
        assert should_inject({"agentspec.io/inject": "false"}) is False

    def test_inject_uppercase_True_returns_false(self):
        # Strict equality — only lowercase "true" opts in
        assert should_inject({"agentspec.io/inject": "True"}) is False

    def test_inject_yes_returns_false(self):
        assert should_inject({"agentspec.io/inject": "yes"}) is False

    def test_inject_1_returns_false(self):
        assert should_inject({"agentspec.io/inject": "1"}) is False

    def test_other_annotations_ignored(self):
        assert should_inject({"some.other/key": "true"}) is False


# ── is_sidecar_present ────────────────────────────────────────────────────────

class TestIsSidecarPresent:
    def test_no_containers_returns_false(self):
        assert is_sidecar_present({"containers": []}) is False

    def test_no_containers_key_returns_false(self):
        assert is_sidecar_present({}) is False

    def test_only_agent_container_returns_false(self):
        spec = _pod_spec([{"name": "agent", "image": "python:3.12-slim"}])
        assert is_sidecar_present(spec) is False

    def test_sidecar_present_returns_true(self):
        spec = _pod_spec([
            {"name": "agent", "image": "python:3.12-slim"},
            {"name": "agentspec-sidecar", "image": "ghcr.io/agentspec/sidecar:latest"},
        ])
        assert is_sidecar_present(spec) is True

    def test_partial_name_match_is_false(self):
        # "agentspec" alone must NOT trigger — exact name required
        spec = _pod_spec([{"name": "agentspec", "image": "some/image"}])
        assert is_sidecar_present(spec) is False

    def test_sidecar_suffix_only_is_false(self):
        spec = _pod_spec([{"name": "sidecar", "image": "some/image"}])
        assert is_sidecar_present(spec) is False


# ── build_sidecar_patch ───────────────────────────────────────────────────────

class TestBuildSidecarPatch:
    def test_annotated_pod_returns_nonempty_patch(self):
        annotations = {"agentspec.io/inject": "true"}
        spec = _pod_spec()
        patch = build_sidecar_patch(spec, annotations)
        assert len(patch) > 0

    def test_patch_adds_agentspec_sidecar_container(self):
        annotations = {"agentspec.io/inject": "true"}
        spec = _pod_spec()
        patch = build_sidecar_patch(spec, annotations)
        container_ops = [op for op in patch if op.get("path") == "/spec/containers/-"]
        assert len(container_ops) == 1
        assert container_ops[0]["value"]["name"] == "agentspec-sidecar"

    def test_unannotated_pod_returns_empty_patch(self):
        annotations = {}
        spec = _pod_spec()
        patch = build_sidecar_patch(spec, annotations)
        assert patch == []

    def test_inject_false_returns_empty_patch(self):
        annotations = {"agentspec.io/inject": "false"}
        spec = _pod_spec()
        patch = build_sidecar_patch(spec, annotations)
        assert patch == []

    def test_sidecar_already_present_is_idempotent(self):
        annotations = {"agentspec.io/inject": "true"}
        spec = _pod_spec([
            {"name": "agent", "image": "python:3.12-slim"},
            {"name": "agentspec-sidecar", "image": "ghcr.io/agentspec/sidecar:latest"},
        ])
        patch = build_sidecar_patch(spec, annotations)
        assert patch == []

    def test_custom_configmap_annotation_sets_volume_mount(self):
        annotations = {
            "agentspec.io/inject": "true",
            "agentspec.io/manifest-configmap": "my-agent-config",
        }
        spec = _pod_spec()
        patch = build_sidecar_patch(spec, annotations)
        # Find the container op
        container_ops = [op for op in patch if op.get("path") == "/spec/containers/-"]
        assert len(container_ops) == 1
        sidecar = container_ops[0]["value"]
        # Volume mount must reference the configured ConfigMap name
        mount_names = [vm["name"] for vm in sidecar.get("volumeMounts", [])]
        assert "agent-yaml" in mount_names

    def test_check_interval_annotation_sets_env(self):
        annotations = {
            "agentspec.io/inject": "true",
            "agentspec.io/check-interval": "60",
        }
        spec = _pod_spec()
        patch = build_sidecar_patch(spec, annotations)
        container_ops = [op for op in patch if op.get("path") == "/spec/containers/-"]
        sidecar = container_ops[0]["value"]
        env_names = {e["name"]: e["value"] for e in sidecar.get("env", [])}
        assert "AGENTSPEC_CHECK_INTERVAL" in env_names
        assert env_names["AGENTSPEC_CHECK_INTERVAL"] == "60"

    def test_patch_op_is_add(self):
        annotations = {"agentspec.io/inject": "true"}
        patch = build_sidecar_patch(_pod_spec(), annotations)
        for op in patch:
            assert op["op"] == "add"

    def test_sidecar_exposes_ports_4000_and_4001(self):
        annotations = {"agentspec.io/inject": "true"}
        patch = build_sidecar_patch(_pod_spec(), annotations)
        container_ops = [op for op in patch if op.get("path") == "/spec/containers/-"]
        ports = [p["containerPort"] for p in container_ops[0]["value"].get("ports", [])]
        assert 4000 in ports
        assert 4001 in ports


# ── get_cr_name ───────────────────────────────────────────────────────────────

class TestGetCRName:
    def test_default_falls_back_to_pod_name(self):
        assert get_cr_name({}, "my-pod") == "my-pod"

    def test_agent_name_annotation_overrides_pod_name(self):
        annotations = {"agentspec.io/agent-name": "custom-agent"}
        assert get_cr_name(annotations, "pod-xyz") == "custom-agent"

    def test_empty_agent_name_falls_back_to_pod_name(self):
        annotations = {"agentspec.io/agent-name": ""}
        assert get_cr_name(annotations, "my-pod") == "my-pod"

    def test_agent_name_strips_whitespace(self):
        annotations = {"agentspec.io/agent-name": "  my-agent  "}
        assert get_cr_name(annotations, "pod-xyz") == "my-agent"


# ── build_admission_response ──────────────────────────────────────────────────

class TestBuildAdmissionResponse:
    def test_response_includes_uid(self):
        response = build_admission_response("test-uid-123", [])
        assert response["response"]["uid"] == "test-uid-123"

    def test_allowed_is_always_true(self):
        response = build_admission_response("uid", [])
        assert response["response"]["allowed"] is True

    def test_empty_patch_no_patch_fields(self):
        # H-4 fix: patch and patchType must be ABSENT (not null) for empty patches
        response = build_admission_response("uid", [])
        assert "patch" not in response["response"]
        assert "patchType" not in response["response"]

    def test_nonempty_patch_includes_base64_patch(self):
        ops = [{"op": "add", "path": "/spec/containers/-", "value": {"name": "x"}}]
        response = build_admission_response("uid", ops)
        encoded = response["response"]["patch"]
        decoded = json.loads(base64.b64decode(encoded))
        assert decoded == ops

    def test_nonempty_patch_sets_json_patch_type(self):
        ops = [{"op": "add", "path": "/spec/containers/-", "value": {}}]
        response = build_admission_response("uid", ops)
        assert response["response"]["patchType"] == "JSONPatch"

    def test_api_version_present(self):
        response = build_admission_response("uid", [])
        assert response["apiVersion"] == "admission.k8s.io/v1"

    def test_kind_is_admission_review(self):
        response = build_admission_response("uid", [])
        assert response["kind"] == "AdmissionReview"


# ── should_inject — default mode ──────────────────────────────────────────────

class TestShouldInjectDefaultMode:
    def test_no_annotation_injects_in_default_mode(self):
        assert should_inject({}, inject_mode="default") is True

    def test_inject_false_opts_out_in_default_mode(self):
        assert should_inject({"agentspec.io/inject": "false"}, inject_mode="default") is False

    def test_inject_true_still_injects_in_default_mode(self):
        assert should_inject({"agentspec.io/inject": "true"}, inject_mode="default") is True

    def test_other_annotations_do_not_opt_out_in_default_mode(self):
        assert should_inject({"app": "my-service"}, inject_mode="default") is True

    def test_annotation_mode_unchanged_by_default_mode_param(self):
        # annotation mode still requires explicit opt-in
        assert should_inject({}, inject_mode="annotation") is False
        assert should_inject({"agentspec.io/inject": "true"}, inject_mode="annotation") is True


# ── build_sidecar_patch — inject_mode ─────────────────────────────────────────

class TestBuildSidecarPatchInjectMode:
    def test_default_mode_injects_unannotated_pod(self):
        patch = build_sidecar_patch(_pod_spec(), {}, inject_mode="default")
        assert len(patch) > 0

    def test_default_mode_skips_opted_out_pod(self):
        annotations = {"agentspec.io/inject": "false"}
        patch = build_sidecar_patch(_pod_spec(), annotations, inject_mode="default")
        assert patch == []

    def test_annotation_mode_skips_unannotated_pod(self):
        patch = build_sidecar_patch(_pod_spec(), {}, inject_mode="annotation")
        assert patch == []


# ── build_sidecar_patch — OPA injection ───────────────────────────────────────

class TestBuildSidecarPatchOPA:
    def _annotated(self, extra=None):
        return {"agentspec.io/inject": "true", "agentspec.io/agent-name": "gymcoach", **(extra or {})}

    def test_opa_disabled_no_opa_container(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=False)
        names = [op["value"]["name"] for op in patch if op.get("path") == "/spec/containers/-"]
        assert "agentspec-opa" not in names

    def test_opa_enabled_adds_opa_container(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=True)
        names = [op["value"]["name"] for op in patch if op.get("path") == "/spec/containers/-"]
        assert "agentspec-opa" in names

    def test_opa_enabled_adds_opa_policy_volume(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=True)
        volume_ops = [op for op in patch if "volumes" in op.get("path", "")]
        volume_names = [op["value"]["name"] for op in volume_ops]
        assert "agentspec-opa-policy" in volume_names

    def test_opa_volume_configmap_name_uses_agent_name(self):
        patch = build_sidecar_patch(
            _pod_spec(), self._annotated(), opa_enabled=True,
            opa_policy_configmap_suffix="opa-policy",
        )
        volume_ops = [op for op in patch if "volumes" in op.get("path", "")]
        opa_vol = next(op for op in volume_ops if op["value"]["name"] == "agentspec-opa-policy")
        assert opa_vol["value"]["configMap"]["name"] == "gymcoach-opa-policy"

    def test_opa_enabled_sets_opa_url_env_on_sidecar(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=True)
        sidecar_op = next(op for op in patch if op.get("value", {}).get("name") == "agentspec-sidecar")
        env = {e["name"]: e["value"] for e in sidecar_op["value"].get("env", [])}
        assert env.get("OPA_URL") == "http://localhost:8181"

    def test_opa_enabled_sets_opa_proxy_mode_env(self):
        patch = build_sidecar_patch(
            _pod_spec(), self._annotated(), opa_enabled=True, opa_proxy_mode="enforce"
        )
        sidecar_op = next(op for op in patch if op.get("value", {}).get("name") == "agentspec-sidecar")
        env = {e["name"]: e["value"] for e in sidecar_op["value"].get("env", [])}
        assert env.get("OPA_PROXY_MODE") == "enforce"

    def test_per_pod_annotation_overrides_global_opa_mode(self):
        annotations = {
            "agentspec.io/inject": "true",
            "agentspec.io/agent-name": "gymcoach",
            "agentspec.io/opa-proxy-mode": "enforce",  # pod-level override
        }
        patch = build_sidecar_patch(
            _pod_spec(), annotations, opa_enabled=True, opa_proxy_mode="track"
        )
        sidecar_op = next(op for op in patch if op.get("value", {}).get("name") == "agentspec-sidecar")
        env = {e["name"]: e["value"] for e in sidecar_op["value"].get("env", [])}
        assert env.get("OPA_PROXY_MODE") == "enforce"

    def test_opa_disabled_no_opa_url_env_on_sidecar(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=False)
        sidecar_op = next(op for op in patch if op.get("value", {}).get("name") == "agentspec-sidecar")
        env_names = [e["name"] for e in sidecar_op["value"].get("env", [])]
        assert "OPA_URL" not in env_names
        assert "OPA_PROXY_MODE" not in env_names

    def test_opa_container_exposes_port_8181(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=True)
        opa_op = next(op for op in patch if op.get("value", {}).get("name") == "agentspec-opa")
        ports = [p["containerPort"] for p in opa_op["value"].get("ports", [])]
        assert 8181 in ports

    def test_opa_container_has_security_context(self):
        patch = build_sidecar_patch(_pod_spec(), self._annotated(), opa_enabled=True)
        opa_op = next(op for op in patch if op.get("value", {}).get("name") == "agentspec-opa")
        sc = opa_op["value"].get("securityContext", {})
        assert sc.get("allowPrivilegeEscalation") is False
        assert sc.get("runAsNonRoot") is True

    def test_volume_paths_correct_when_pod_has_no_existing_volumes(self):
        # First volume op → "/spec/volumes" (creates array)
        # Second volume op → "/spec/volumes/-" (appends)
        spec = _pod_spec()  # no volumes key
        patch = build_sidecar_patch(spec, self._annotated(), opa_enabled=True)
        vol_ops = [op for op in patch if "volumes" in op.get("path", "")]
        assert vol_ops[0]["path"] == "/spec/volumes"
        assert vol_ops[1]["path"] == "/spec/volumes/-"

    def test_volume_paths_correct_when_pod_has_existing_volumes(self):
        # Both volume ops → "/spec/volumes/-" (append)
        spec = {**_pod_spec(), "volumes": [{"name": "existing", "emptyDir": {}}]}
        patch = build_sidecar_patch(spec, self._annotated(), opa_enabled=True)
        vol_ops = [op for op in patch if "volumes" in op.get("path", "")]
        assert all(op["path"] == "/spec/volumes/-" for op in vol_ops)


# ── Excluded namespaces ───────────────────────────────────────────────────────

class TestExcludedNamespaces:
    """
    Tests for the _EXCLUDED_NAMESPACES module constant.

    The excluded namespace check runs in the kopf @kopf.on.admission() handler
    in operator.py. This class verifies the default constant values in webhook.py
    that the handler reads at import time.
    """

    def test_default_excluded_namespaces_contains_kube_system(self):
        assert "kube-system" in _mod._EXCLUDED_NAMESPACES

    def test_default_excluded_namespaces_contains_kube_public(self):
        assert "kube-public" in _mod._EXCLUDED_NAMESPACES

    def test_default_excluded_namespaces_contains_kube_node_lease(self):
        assert "kube-node-lease" in _mod._EXCLUDED_NAMESPACES

    def test_excluded_namespaces_is_frozenset(self):
        assert isinstance(_mod._EXCLUDED_NAMESPACES, frozenset)
