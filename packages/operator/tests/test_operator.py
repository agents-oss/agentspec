"""
Unit tests for the SSRF guards in operator.py (_sidecar_url).

operator.py shadows the stdlib 'operator' module by name, so we load it via
importlib to avoid the conflict and keep the import explicit.
"""

import importlib.util
import pathlib

import pytest

# Load our operator.py without triggering the 'operator' stdlib name clash
_OPERATOR_PATH = pathlib.Path(__file__).parent.parent / "operator.py"
_spec = importlib.util.spec_from_file_location("agentspec_operator", _OPERATOR_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

_sidecar_url = _mod._sidecar_url


# ── Valid inputs ──────────────────────────────────────────────────────────────

class TestSidecarUrlValid:
    def test_short_name_produces_cluster_dns(self):
        url = _sidecar_url({"sidecarServiceName": "gymcoach-sidecar"}, "gymcoach", "demo")
        assert url == "http://gymcoach-sidecar.demo.svc.cluster.local:4001"

    def test_default_port_4001(self):
        url = _sidecar_url({"sidecarServiceName": "my-sidecar"}, "agent", "default")
        assert url.endswith(":4001")

    def test_custom_port_accepted(self):
        url = _sidecar_url(
            {"sidecarServiceName": "my-sidecar", "sidecarPort": 8080},
            "agent", "default",
        )
        assert url.endswith(":8080")

    def test_missing_service_name_defaults_to_agent_sidecar(self):
        url = _sidecar_url({}, "gymcoach", "demo")
        assert url == "http://gymcoach-sidecar.demo.svc.cluster.local:4001"

    def test_none_service_name_defaults_to_agent_sidecar(self):
        url = _sidecar_url({"sidecarServiceName": None}, "trading-bot", "prod")
        assert "trading-bot-sidecar" in url

    def test_namespace_embedded_in_url(self):
        url = _sidecar_url({"sidecarServiceName": "svc"}, "agent", "my-namespace")
        assert ".my-namespace.svc.cluster.local" in url

    def test_port_boundary_1024_accepted(self):
        url = _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 1024}, "a", "ns")
        assert ":1024" in url

    def test_port_boundary_65535_accepted(self):
        url = _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 65535}, "a", "ns")
        assert ":65535" in url

    def test_single_char_name_accepted(self):
        # Minimum valid DNS label is 1 character
        url = _sidecar_url({"sidecarServiceName": "a"}, "agent", "ns")
        assert "http://a.ns.svc.cluster.local:" in url

    def test_hyphenated_name_accepted(self):
        url = _sidecar_url({"sidecarServiceName": "my-sidecar-v2"}, "agent", "ns")
        assert "my-sidecar-v2" in url


# ── SSRF: dotted names rejected ───────────────────────────────────────────────

class TestSidecarUrlRejectsDottedNames:
    def test_ip_address_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "169.254.169.254"}, "agent", "ns")

    def test_cross_namespace_service_rejected(self):
        # kube-system service via FQDN would escape namespace scope
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url(
                {"sidecarServiceName": "kubernetes.default.svc.cluster.local"},
                "agent", "ns",
            )

    def test_dotted_subdomain_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "evil.service"}, "agent", "ns")

    def test_leading_dot_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": ".hidden"}, "agent", "ns")

    def test_trailing_dot_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "service."}, "agent", "ns")

    def test_uppercase_rejected(self):
        # DNS labels in k8s must be lowercase
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "MyService"}, "agent", "ns")

    def test_leading_hyphen_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "-bad-name"}, "agent", "ns")

    def test_trailing_hyphen_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "bad-name-"}, "agent", "ns")

    def test_slash_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "path/traversal"}, "agent", "ns")

    def test_at_symbol_rejected(self):
        with pytest.raises(ValueError, match="not a valid DNS label"):
            _sidecar_url({"sidecarServiceName": "user@host"}, "agent", "ns")


# ── Port range validation ─────────────────────────────────────────────────────

class TestSidecarUrlRejectsInvalidPorts:
    def test_port_0_rejected(self):
        with pytest.raises(ValueError, match="out of the allowed range"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 0}, "a", "ns")

    def test_port_1_rejected(self):
        with pytest.raises(ValueError, match="out of the allowed range"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 1}, "a", "ns")

    def test_port_80_rejected(self):
        # Well-known HTTP port — blocked even though it's valid TCP
        with pytest.raises(ValueError, match="out of the allowed range"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 80}, "a", "ns")

    def test_port_443_rejected(self):
        with pytest.raises(ValueError, match="out of the allowed range"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 443}, "a", "ns")

    def test_port_1023_rejected(self):
        with pytest.raises(ValueError, match="out of the allowed range"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 1023}, "a", "ns")

    def test_port_65536_rejected(self):
        with pytest.raises(ValueError, match="out of the allowed range"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 65536}, "a", "ns")


# ── H6: Internal proxy ports 4000/4001 must be blocked ────────────────────────

class TestSidecarUrlRejectsInternalPorts:
    def test_port_4000_rejected(self):
        """Port 4000 is the agentspec-sidecar proxy — routing operator traffic there is incorrect."""
        with pytest.raises(ValueError, match="conflicts with an agentspec-sidecar internal port"):
            _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 4000}, "a", "ns")

    def test_port_4001_is_valid_control_plane_port(self):
        """Port 4001 is the sidecar control-plane port — it IS the correct operator target."""
        url = _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 4001}, "a", "ns")
        assert ":4001" in url

    def test_port_3999_accepted(self):
        """Port 3999 must be accepted (below reserved range)."""
        url = _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 3999}, "a", "ns")
        assert ":3999" in url

    def test_port_4002_accepted(self):
        """Port 4002 must be accepted (above reserved range)."""
        url = _sidecar_url({"sidecarServiceName": "svc", "sidecarPort": 4002}, "a", "ns")
        assert ":4002" in url
