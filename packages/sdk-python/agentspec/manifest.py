"""
Manifest loader — reads agent.yaml with PyYAML.
"""

from __future__ import annotations

from typing import Any, Dict

import yaml


def load_manifest(path: str) -> Dict[str, Any]:
    """Load and parse an agent.yaml file. Returns the raw manifest dict."""
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"agent.yaml at {path!r} must be a YAML mapping")
    return data
