"""Shared fixtures for agentspec Python SDK tests."""

import pytest


@pytest.fixture
def minimal_manifest():
    """Minimal valid agent manifest dict for testing."""
    return {
        "apiVersion": "agentspec.io/v1",
        "kind": "AgentSpec",
        "metadata": {
            "name": "test-agent",
            "version": "1.0.0",
            "description": "Test agent for SDK tests",
        },
        "spec": {
            "model": {
                "provider": "groq",
                "id": "llama-3.3-70b-versatile",
                "apiKey": "$env:GROQ_API_KEY",
            },
            "prompts": {
                "system": "You are a test agent.",
                "hotReload": False,
            },
        },
    }
