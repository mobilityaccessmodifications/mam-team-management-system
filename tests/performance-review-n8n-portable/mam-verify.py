#!/usr/bin/env python3
"""Verify the local MAM n8n API configuration without exposing its key."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"


def load_local_env() -> dict[str, str]:
    if not ENV_FILE.is_file():
        raise RuntimeError("Missing .env. Copy .env.example to .env and add the MAM API details.")

    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(ENV_FILE.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RuntimeError(f"Invalid .env entry on line {line_number}.")
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    try:
        config = load_local_env()
        if config.get("N8N_INSTANCE_LABEL") != "MAM":
            raise RuntimeError("N8N_INSTANCE_LABEL must be exactly MAM.")

        base_url = config.get("N8N_BASE_URL", "").rstrip("/")
        api_key = config.get("N8N_API_KEY", "")
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None or "?" in base_url or "#" in base_url:
            raise RuntimeError("N8N_BASE_URL must be a complete HTTPS URL without credentials, query or fragment.")
        if not api_key or api_key == "replace_with_mam_n8n_api_key":
            raise RuntimeError("N8N_API_KEY has not been configured.")

        request = Request(
            f"{base_url}/api/v1/workflows?limit=1",
            headers={"X-N8N-API-KEY": api_key, "Accept": "application/json"},
        )
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            payload = json.load(response)

        workflow_count = len(payload.get("data", [])) if isinstance(payload, dict) else 0
        print(f"Verified MAM n8n API at {parsed.netloc} (sample returned {workflow_count} workflow(s)).")
        return 0
    except HTTPError as error:
        print(f"MAM n8n API returned HTTP {error.code}; check the URL and API-key permissions.", file=sys.stderr)
    except URLError as error:
        print(f"Could not reach the MAM n8n API: {error.reason}", file=sys.stderr)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"Configuration check failed: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
