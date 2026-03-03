"""
CLI entry point for PresidioProbe.

Usage:
    python -m agentspec.presidio_probe [options]

Examples:
    # Scan inline texts for PII (proves SEC-LLM-06 + MEM-01)
    python -m agentspec.presidio_probe \\
        --manifest agent.yaml \\
        --text "My SSN is 123-45-6789" \\
        --text "card: 4111-1111-1111-1111"

    # Scan a log file for unredacted PII (proves OBS-03)
    python -m agentspec.presidio_probe \\
        --manifest agent.yaml \\
        --log-file /var/log/agent/agent.log

    # Auto-submit proof to sidecar on pass
    python -m agentspec.presidio_probe \\
        --manifest agent.yaml \\
        --log-file /var/log/agent/agent.log \\
        --sidecar-url http://localhost:4001 \\
        --submit

Exit codes:
    0 — no PII found (passed)
    1 — PII found (failed) or error
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m agentspec.presidio_probe",
        description="Scan agent outputs or logs for unredacted PII using Microsoft Presidio.",
    )
    parser.add_argument(
        "--manifest",
        required=True,
        metavar="PATH",
        help="Path to agent.yaml manifest file.",
    )

    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--text",
        dest="texts",
        action="append",
        metavar="TEXT",
        help="Text to scan for PII. Repeatable. Mutually exclusive with --log-file.",
    )
    source.add_argument(
        "--log-file",
        metavar="PATH",
        help="Log file to scan line by line for PII. Mutually exclusive with --text.",
    )

    parser.add_argument(
        "--sidecar-url",
        metavar="URL",
        default=None,
        help="AgentSpec sidecar URL (e.g. http://localhost:4001). Required for --submit.",
    )
    parser.add_argument(
        "--submit",
        action="store_true",
        default=False,
        help="Auto-submit proof to sidecar if scan passes. Requires --sidecar-url.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.7,
        metavar="FLOAT",
        help="Minimum Presidio confidence score to report as PII (default: 0.7).",
    )
    parser.add_argument(
        "--json",
        dest="output_json",
        action="store_true",
        default=False,
        help="Output ProbeScanResult as JSON instead of human-readable text.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.submit and not args.sidecar_url:
        print("ERROR: --submit requires --sidecar-url", file=sys.stderr)
        return 1

    try:
        from agentspec.presidio_probe import PresidioProbe
    except ImportError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    try:
        probe = PresidioProbe.from_yaml(
            args.manifest,
            sidecar_url=args.sidecar_url,
            score_threshold=args.threshold,
        )
    except ImportError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"ERROR loading manifest: {exc}", file=sys.stderr)
        return 1

    # Run the appropriate scan
    if args.log_file:
        result = probe.scan_log_file(args.log_file)
    else:
        result = probe.scan_texts(args.texts or [])

    # Output
    if args.output_json:
        payload = dataclasses.asdict(result)
        print(json.dumps(payload, indent=2))
    else:
        status = "PASSED — no PII found" if result.passed else "FAILED — PII detected"
        print(f"\nPresidio PII Probe — {status}")
        print(f"  Rules proved : {', '.join(result.rule_ids)}")
        print(f"  Items scanned: {result.scanned_items}")
        print(f"  Entities     : {', '.join(result.entities_checked)}")
        if result.hits:
            print(f"\n  Hits ({len(result.hits)}):")
            for hit in result.hits:
                print(
                    f"    [{hit.entity_type}] score={hit.score:.2f} "
                    f"offset={hit.start}-{hit.end}  excerpt={hit.text_excerpt!r}"
                )
        print()

    # Optionally submit proof
    if args.submit and result.passed:
        ok = probe.submit_proof(result, verified_by="presidio-cli")
        if ok:
            print("Proof submitted to sidecar.", file=sys.stderr)
        else:
            print("WARNING: proof submission failed.", file=sys.stderr)

    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(main())
