#!/usr/bin/env python3
"""
Daydiff API Export to CSV (Standalone)

Fetches the same DevGrid API data as daydiff and writes one CSV per dataset.
No npm/Node required. Uses Python stdlib only.

Usage:
  python3 export-to-csv.py
  python3 export-to-csv.py --datasets "Applications,Repositories"
  python3 export-to-csv.py --exclude "Components,vulns-Digital One LFI"
  python3 export-to-csv.py --config export-config.json --output ./my-export

Requires .env with API_BASE_URL and API_KEY.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen, build_opener, HTTPSHandler, ProxyHandler, install_opener

# ─── Embedded config (synced from config/datasets.mjs + config/assets.mjs) ───

PLATFORM_PAGE_SIZE = 200
VULN_PAGE_SIZE = 250
VULN_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
MAX_ITERATIONS = 2000
OVERLAP_RATIO = 0.25

PLATFORM_DATASETS = [
    {"name": "Applications", "endpoint": "/applications", "params": {"limit": PLATFORM_PAGE_SIZE}},
    {"name": "Components", "endpoint": "/components", "params": {"limit": PLATFORM_PAGE_SIZE}},
    {"name": "Resources", "endpoint": "/resources", "params": {"limit": PLATFORM_PAGE_SIZE}},
    {"name": "Repositories", "endpoint": "/repositories", "params": {"limit": PLATFORM_PAGE_SIZE}},
]

def try_load_assets_from_mjs():
    """If run from daydiff repo, parse config/assets.mjs; else return None."""
    repo_root = Path(__file__).resolve().parent.parent
    mjs_path = repo_root / "config" / "assets.mjs"
    if not mjs_path.exists():
        return None
    text = mjs_path.read_text(encoding="utf-8")
    assets = []
    # Match { name: '...', vulnerableId: '...' } or "..." variants
    pattern = r"\{\s*name:\s*['\"]([^'\"]*)['\"],\s*vulnerableId:\s*['\"]([^'\"]*)['\"]"
    for m in re.finditer(pattern, text):
        assets.append({"name": m.group(1), "vulnerableId": m.group(2)})
    return assets if assets else None


# Embedded from config/assets.mjs — override via --config or config/assets.mjs when in repo
ASSETS = [
    {"name": "Digital One Flex (17040)", "vulnerableId": "7d53603e-0973-437d-a3da-a129cb8108ef"},
    {"name": "Digital One LFI (12430)", "vulnerableId": "eb1148af-b67d-4e13-a07d-95d473a097a0"},
    {"name": "Consumer e-Banking Services (2466)", "vulnerableId": "b6473451-0525-41d7-8a81-0faad1edf1c4"},
]


def load_env(env_path=None):
    """Load .env into os.environ. No external deps."""
    path = env_path or Path(__file__).resolve().parent.parent / ".env"
    if not Path(path).exists():
        path = Path.cwd() / ".env"
    if not Path(path).exists():
        return None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                os.environ.setdefault(k.strip(), v)
    return str(path)


def load_config(config_path):
    """Load JSON config with optional assets and datasets toggle map."""
    data = {}
    if config_path and Path(config_path).exists():
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)
    return data


def api_request(base_url, api_key, path, params=None, proxy_url=None, ca_path=None, strict_ssl=True):
    """GET request with retry on 429/5xx."""
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    if params:
        url += "?" + urlencode({k: v for k, v in params.items() if v is not None})
    headers = {"Accept": "application/json", "Content-Type": "application/json", "x-api-key": api_key}
    req = Request(url, headers=headers, method="GET")

    handlers = []
    if proxy_url:
        handlers.append(ProxyHandler({"http": proxy_url, "https": proxy_url}))
    if ca_path and Path(ca_path).exists():
        import ssl
        ctx = ssl.create_default_context(cafile=ca_path)
        handlers.append(HTTPSHandler(context=ctx))
    elif not strict_ssl:
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(HTTPSHandler(context=ctx))
    if handlers:
        opener = build_opener(*handlers)
        install_opener(opener)

    last_err = None
    for attempt in range(5):
        try:
            with urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504):
                delay = 500 * (2 ** attempt) / 1000
                print(f"[api] {e.code} {path}, retry {attempt + 1}/5 in {delay:.1f}s", file=sys.stderr)
                time.sleep(delay)
            else:
                raise
        except (URLError, OSError) as e:
            last_err = e
            err_str = str(e).lower()
            if "ssl" in err_str or "certificate" in err_str:
                print(
                    "[api] SSL certificate verification failed. In .env set:\n"
                    "  CA_CERT_PATH=/path/to/corporate-ca-bundle.pem  (if behind TLS-inspecting proxy)\n"
                    "  or STRICT_SSL=false  (last resort, disables verification)",
                    file=sys.stderr,
                )
                raise
            delay = 500 * (2 ** attempt) / 1000
            print(f"[api] {e}, retry {attempt + 1}/5 in {delay:.1f}s", file=sys.stderr)
            time.sleep(delay)
    raise last_err


def extract_rows(body):
    """Extract data array from DevGrid response."""
    if isinstance(body, list):
        return body
    if body and isinstance(body.get("data"), list):
        return body["data"]
    raise ValueError("Cannot extract rows from response")


def extract_pagination(body):
    """Extract pagination metadata."""
    pag = (body or {}).get("pagination") or (body or {}).get("meta")
    if not pag:
        return None
    return {
        "total": pag.get("total") or pag.get("totalCount") or pag.get("count") or 0,
        "pageSize": pag.get("limit") or pag.get("pageSize") or pag.get("per_page") or 0,
        "offset": pag.get("offset"),
    }


def fetch_platform_dataset(base_url, api_key, name, endpoint, params, proxy, ca_path, strict_ssl):
    """Fetch a single platform dataset (paginated, overlap stride)."""
    all_rows = []
    first_params = dict(params)
    body = api_request(base_url, api_key, endpoint, first_params, proxy, ca_path, strict_ssl)
    rows = extract_rows(body)
    pag = extract_pagination(body)

    all_rows.extend(rows)
    if not pag or pag["total"] == 0:
        print(f"[fetch] {name}: {len(rows)} records (no pagination)")
        return all_rows

    total = pag["total"]
    page_size = pag["pageSize"] or 200
    if rows:
        page_size = min(page_size, len(rows))
    stride = max(1, int(page_size * (1 - OVERLAP_RATIO)))
    print(f"[fetch] {name}: {total} total, page size {page_size}")

    current_offset = page_size
    iteration = 1
    while current_offset < total and iteration < MAX_ITERATIONS:
        page_params = {**params, "offset": current_offset}
        try:
            page_body = api_request(base_url, api_key, endpoint, page_params, proxy, ca_path, strict_ssl)
            page_rows = extract_rows(page_body)
            if not page_rows:
                break
            all_rows.extend(page_rows)
            if iteration % 10 == 0:
                print(f"[fetch] {name}: ~{len(all_rows)}/{total} (offset {current_offset})")
            if len(page_rows) < page_size:
                break
            current_offset += stride
            iteration += 1
        except Exception as e:
            print(f"[fetch] {name}: pagination failed ({e}), got {len(all_rows)}/{total}", file=sys.stderr)
            break

    return all_rows


def fetch_vulnerability_dataset(base_url, api_key, name, vulnerable_id, proxy, ca_path, strict_ssl):
    """Fetch vulnerability dataset: partition by severity, 2 passes, dedupe by id."""
    merged = {}
    for severity in VULN_SEVERITIES:
        for pass_num in range(1, 3):
            params = {"vulnerableId": vulnerable_id, "severity": severity, "limit": VULN_PAGE_SIZE}
            body = api_request(base_url, api_key, "/vulnerabilities", params, proxy, ca_path, strict_ssl)
            rows = extract_rows(body)
            for row in rows:
                rid = row.get("id")
                if rid:
                    merged[rid] = row
            if not rows:
                break
    return list(merged.values())


def flatten_row(row):
    """Flatten row for CSV: nested objects → JSON string."""
    out = {}
    for k, v in row.items():
        if v is None:
            out[k] = ""
        elif isinstance(v, (dict, list)):
            out[k] = json.dumps(v)
        else:
            out[k] = str(v)
    return out


def sanitize_filename(name):
    """Replace unsafe chars for filename."""
    return re.sub(r'[^\w\-_.]', '_', name)[:100]


def write_csv(path, rows):
    """Write rows to CSV with RFC 4180 escaping."""
    if not rows:
        return
    flattened = [flatten_row(r) for r in rows]
    keys = list(flattened[0].keys())  # preserve order from first row
    for r in flattened[1:]:
        for k in r:
            if k not in keys:
                keys.append(k)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(flattened)


def build_datasets(assets, config_datasets=None):
    """Build full dataset list with toggles."""
    datasets = []
    for ds in PLATFORM_DATASETS:
        enabled = True
        if config_datasets is not None and ds["name"] in config_datasets:
            enabled = bool(config_datasets.get(ds["name"], True))
        datasets.append({**ds, "category": "platform", "enabled": enabled})

    for asset in assets:
        name = f"vulns-{asset['name']}"
        enabled = True
        if config_datasets is not None and name in config_datasets:
            enabled = bool(config_datasets.get(name, True))
        datasets.append({
            "name": name,
            "endpoint": "/vulnerabilities",
            "category": "vulnerability",
            "vulnerableId": asset["vulnerableId"],
            "enabled": enabled,
        })

    return datasets


def apply_cli_filters(datasets, include_names=None, exclude_names=None):
    """Apply --datasets or --exclude overrides."""
    if include_names:
        include_set = {s.strip() for s in include_names.split(",") if s.strip()}
        for ds in datasets:
            ds["enabled"] = ds["name"] in include_set
    elif exclude_names:
        exclude_set = {s.strip() for s in exclude_names.split(",") if s.strip()}
        for ds in datasets:
            ds["enabled"] = ds["name"] not in exclude_set


def main():
    parser = argparse.ArgumentParser(description="Export Daydiff API data to CSV")
    parser.add_argument("--config", help="JSON config with assets and/or datasets toggle map")
    parser.add_argument("--output", "-o", help="Output directory (default: daydiff-export-YYYY-MM-DD)")
    parser.add_argument("--datasets", help="Comma-separated dataset names to fetch (whitelist)")
    parser.add_argument("--exclude", help="Comma-separated dataset names to exclude")
    parser.add_argument("--check-env", action="store_true", help="Show which .env was loaded and verify API config")
    args = parser.parse_args()

    env_path = load_env()
    base_url = os.environ.get("API_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("API_KEY", "")

    if args.check_env:
        def _mask(s):
            if not s or len(s) < 8:
                return "(empty)" if not s else "***"
            return s[:4] + "..." + s[-2:]
        print("[check-env] .env path:", env_path or "(not found)")
        print("[check-env] API_BASE_URL:", base_url or "(empty)")
        print("[check-env] API_KEY:", ("ok " + _mask(api_key)) if api_key else "(empty)")
        print("[check-env] STRICT_SSL:", os.environ.get("STRICT_SSL", "true"))
        print("[check-env] CA_CERT_PATH:", os.environ.get("CA_CERT_PATH") or "(not set)")
        return
    if not base_url or not api_key:
        print("Error: API_BASE_URL and API_KEY required (set in .env or environment)", file=sys.stderr)
        sys.exit(1)

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or None
    strict_ssl = os.environ.get("STRICT_SSL", "true").lower() != "false"
    ca_path = os.environ.get("CA_CERT_PATH")

    config = load_config(args.config)
    assets = config.get("assets") or try_load_assets_from_mjs() or ASSETS
    config_datasets = config.get("datasets")
    datasets = build_datasets(assets, config_datasets)
    apply_cli_filters(datasets, args.datasets, args.exclude)

    out_dir = args.output or f"daydiff-export-{time.strftime('%Y-%m-%d')}"
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    print(f"\n[fetch] Output: {out_dir}\n")

    platform_ds = [d for d in datasets if d["category"] == "platform" and d["enabled"]]
    vuln_ds = [d for d in datasets if d["category"] == "vulnerability" and d["enabled"]]

    for ds in platform_ds:
        print(f"[fetch] {ds['name']}...")
        rows = fetch_platform_dataset(
            base_url, api_key, ds["name"], ds["endpoint"], ds["params"],
            proxy, ca_path, strict_ssl
        )
        path = Path(out_dir) / f"{sanitize_filename(ds['name'])}.csv"
        write_csv(path, rows)
        print(f"[fetch] {ds['name']}: wrote {len(rows)} rows to {path}\n")

    for ds in vuln_ds:
        print(f"[fetch] {ds['name']}...")
        rows = fetch_vulnerability_dataset(
            base_url, api_key, ds["name"], ds["vulnerableId"],
            proxy, ca_path, strict_ssl
        )
        path = Path(out_dir) / f"{sanitize_filename(ds['name'])}.csv"
        write_csv(path, rows)
        print(f"[fetch] {ds['name']}: wrote {len(rows)} rows to {path}\n")

    print(f"[fetch] Complete. Output in {out_dir}")


if __name__ == "__main__":
    main()
