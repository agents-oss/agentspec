"""
test_scenarios.py — Parametrized YAML scenario runner.

Each file under scenarios/*.yaml becomes a separate pytest test case.
Adding a new scenario = drop a new .yaml file in scenarios/.

Schema reference: see plan docs or scenarios/01-proxy-passthrough.yaml.
"""
from __future__ import annotations

import re
import pytest
import httpx

from conftest import load_scenarios


@pytest.mark.parametrize("scenario", load_scenarios())
def test_scenario(scenario: dict, port_forward):
    proxy_url, control_url = port_forward(
        scenario["agent"],
        scenario["proxy_port"],
        scenario["control_port"],
    )

    for step in scenario.get("steps", []):
        endpoint = step.get("endpoint", "proxy")
        base = proxy_url if endpoint == "proxy" else control_url
        url = base + step["path"]

        r = httpx.request(
            step.get("method", "GET"),
            url,
            json=step.get("body"),
            timeout=10,
        )

        _assert_step(step["name"], r, step.get("expect", {}))


# ── Assertion helpers ─────────────────────────────────────────────────────────

def _assert_step(name: str, r: httpx.Response, expect: dict) -> None:
    if "status" in expect:
        assert r.status_code == expect["status"], (
            f"[{name}] expected status {expect['status']}, got {r.status_code}"
        )

    for h in expect.get("headers_absent", []):
        assert h.lower() not in r.headers, (
            f"[{name}] header '{h}' must be absent but was present"
        )

    for h in expect.get("headers_present", []):
        assert h.lower() in r.headers, (
            f"[{name}] header '{h}' must be present but was absent"
        )

    if "jq" in expect:
        val = _resolve_path(r.json(), expect["jq"])
        if expect.get("not_null"):
            assert val is not None, (
                f"[{name}] path '{expect['jq']}' must not be null/None, got {val!r}"
            )
        if "equals" in expect:
            assert val == expect["equals"], (
                f"[{name}] path '{expect['jq']}': expected {expect['equals']!r}, got {val!r}"
            )
        if "contains" in expect:
            assert expect["contains"] in str(val), (
                f"[{name}] path '{expect['jq']}': expected to contain {expect['contains']!r}, got {val!r}"
            )

    if "body_contains" in expect:
        assert expect["body_contains"] in r.text, (
            f"[{name}] body must contain {expect['body_contains']!r}"
        )


def _resolve_path(obj: object, path: str) -> object:
    """Resolve a jq-style dot/bracket path into a value.

    Examples::

        _resolve_path(data, ".[0].requestId")   → data[0]["requestId"]
        _resolve_path(data, ".grade")            → data["grade"]
        _resolve_path(data, ".issues[0].rule")   → data["issues"][0]["rule"]
    """
    for part in re.split(r"\.|(?=\[)", path.lstrip(".")):
        if not part:
            continue
        if part.startswith("[") and part.endswith("]"):
            try:
                obj = obj[int(part[1:-1])]
            except (IndexError, TypeError, KeyError):
                return None
        else:
            if isinstance(obj, dict):
                obj = obj.get(part)
            else:
                return None
    return obj
