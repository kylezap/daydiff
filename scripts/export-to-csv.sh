#!/usr/bin/env bash
#
# Daydiff API Export to CSV (Bash + curl)
#
# Fetches the same DevGrid API data as daydiff and writes one CSV per dataset.
# Uses curl instead of Python — often works better on corporate machines where
# Python's SSL/certificate handling fails behind TLS-inspecting proxies.
#
# Usage:
#   ./export-to-csv.sh
#   ./export-to-csv.sh --datasets "Applications,Repositories"
#   ./export-to-csv.sh --exclude "Components,vulns-Digital One LFI"
#   ./export-to-csv.sh --output ./my-export
#
# Requires: curl, jq.  .env with API_BASE_URL and API_KEY.
#
# SSL/Proxy (for corporate networks):
#   curl uses system libcurl and respects CURL_CA_BUNDLE, SSL_CERT_FILE,
#   HTTPS_PROXY — often already set by corporate IT. If not:
#   In .env: CA_CERT_PATH=/path/to/corporate-ca.pem
#   Or: STRICT_SSL=false (last resort)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM_PAGE_SIZE=200
VULN_PAGE_SIZE=250
VULN_SEVERITIES="CRITICAL HIGH MEDIUM LOW INFO"
MAX_ITERATIONS=2000
OVERLAP_RATIO=0.25

# Platform datasets: name|endpoint
PLATFORM_DATASETS="Applications|/applications
Components|/components
Resources|/resources
Repositories|/repositories"

# Assets: name|vulnerableId (from config/assets.mjs)
ASSETS="Digital One Flex (17040)|7d53603e-0973-437d-a3da-a129cb8108ef
Digital One LFI (12430)|eb1148af-b67d-4e13-a07d-95d473a097a0
Consumer e-Banking Services (2466)|b6473451-0525-41d7-8a81-0faad1edf1c4"

# ─── Load .env ───────────────────────────────────────────────────
load_env() {
  local env_path="$REPO_ROOT/.env"
  [[ -f "$env_path" ]] || env_path=".env"
  if [[ -f "$env_path" ]]; then
    set -a
    # shellcheck source=/dev/null
    source <(grep -v '^#' "$env_path" | grep -v '^$' | sed 's/^/export /')
    set +a
    echo "$env_path"
  else
    echo ""
  fi
}

# ─── Sanitize filename ───────────────────────────────────────────
sanitize_filename() {
  echo "$1" | sed 's/[^a-zA-Z0-9_.-]/_/g' | cut -c1-100
}

# ─── Build curl args (proxy, CA, SSL) ─────────────────────────────
# Corporate machines: curl respects CURL_CA_BUNDLE, SSL_CERT_FILE, HTTPS_PROXY.
# Set CA_CERT_PATH in .env for corporate CA, or STRICT_SSL=false as last resort.
build_curl_opts() {
  CURL_OPTS=(-sS -w "\n%{http_code}" --max-time 60)
  if [[ -n "$HTTPS_PROXY" ]]; then
    CURL_OPTS+=(-x "$HTTPS_PROXY")
  elif [[ -n "$HTTP_PROXY" ]]; then
    CURL_OPTS+=(-x "$HTTP_PROXY")
  fi
  if [[ -n "$CA_CERT_PATH" ]] && [[ -f "$CA_CERT_PATH" ]]; then
    CURL_OPTS+=(--cacert "$CA_CERT_PATH")
  elif [[ "${STRICT_SSL:-true}" =~ ^(false|0|no)$ ]]; then
    CURL_OPTS+=(-k)
  fi
}

# ─── API request with retry ──────────────────────────────────────
api_request() {
  local path="$1" query="$2"
  local url="${BASE_URL%/}/${path#/}"
  [[ -n "$query" ]] && url="${url}?${query}"

  local attempt=1 last_err=""
  while [[ $attempt -le 5 ]]; do
    local tmp
    tmp=$(mktemp)
    local code
    code=$(curl -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      -H "x-api-key: $API_KEY" \
      "${CURL_OPTS[@]}" \
      -o "$tmp" \
      "$url" 2>/dev/null | tail -n1)

    if [[ "$code" =~ ^(429|5[0-9]{2})$ ]]; then
      local delay=$((1 << (attempt - 1)))
      [[ $delay -lt 1 ]] && delay=1
      echo "[api] HTTP $code $path, retry $attempt/5 in ${delay}s" >&2
      sleep "$delay"
      rm -f "$tmp"
      ((attempt++)) || true
      continue
    fi

    if [[ "$code" != "200" ]]; then
      rm -f "$tmp"
      echo "[api] HTTP $code for $url" >&2
      return 1
    fi

    cat "$tmp"
    rm -f "$tmp"
    return 0
  done

  echo "[api] Max retries exceeded for $path" >&2
  return 1
}

# ─── Extract rows from DevGrid response ───────────────────────────
extract_rows() {
  local body="$1"
  if echo "$body" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "$body" | jq -c .
  else
    echo "$body" | jq -c '.data // []'
  fi
}

# ─── Extract pagination metadata ──────────────────────────────────
extract_pagination() {
  local body="$1"
  local total page_size
  total=$(echo "$body" | jq -r '(.pagination // .meta).total // (.pagination // .meta).totalCount // (.pagination // .meta).count // 0')
  page_size=$(echo "$body" | jq -r '(.pagination // .meta).limit // (.pagination // .meta).pageSize // (.pagination // .meta).per_page // 200')
  echo "${total}|${page_size}"
}

# ─── JSON array to CSV (flatten nested as JSON string) ─────────────
json_to_csv() {
  jq -r '
    def to_csv_val:
      if . == null then ""
      elif type == "object" or type == "array" then @json
      else tostring end;
    (.[0] | keys) as $keys |
    ($keys | @csv),
    (.[] | [.[$keys[]] | to_csv_val] | @csv)
  '
}

# ─── Fetch platform dataset (paginated with overlap) ──────────────
fetch_platform() {
  local name="$1" endpoint="$2"
  local all_json="[]"
  local first_body
  first_body=$(api_request "$endpoint" "limit=$PLATFORM_PAGE_SIZE")
  local rows
  rows=$(extract_rows "$first_body")
  local pag
  pag=$(extract_pagination "$first_body")
  local total page_size
  total="${pag%%|*}"
  page_size="${pag##*|}"

  all_json=$(echo "$rows" | jq -s 'add')
  local count
  count=$(echo "$all_json" | jq 'length')
  echo "[fetch] $name: $total total, page size $page_size" >&2

  if [[ "$total" = "0" ]] || [[ -z "$total" ]]; then
    echo "[fetch] $name: $count records (no pagination)" >&2
    echo "$all_json"
    return
  fi

  local stride=$((page_size * 75 / 100))
  [[ $stride -lt 1 ]] && stride=1

  local offset=$page_size iter=1
  while [[ $offset -lt $total ]] && [[ $iter -lt $MAX_ITERATIONS ]]; do
    local page_body
    page_body=$(api_request "$endpoint" "limit=$PLATFORM_PAGE_SIZE&offset=$offset")
    local page_rows
    page_rows=$(extract_rows "$page_body")
    if [[ -z "$page_rows" ]] || [[ "$page_rows" = "null" ]]; then
      break
    fi
    all_json=$(echo "$all_json" $page_rows | jq -s 'add | unique_by(.id)')
    count=$(echo "$all_json" | jq 'length')
    if [[ $((iter % 10)) -eq 0 ]]; then
      echo "[fetch] $name: ~$count/$total (offset $offset)" >&2
    fi
    local page_count
    page_count=$(echo "$page_rows" | jq 'length')
    [[ "$page_count" -lt "$page_size" ]] && break
    offset=$((offset + stride))
    ((iter++)) || true
  done

  echo "$all_json"
}

# ─── Fetch vulnerability dataset (by severity, 2 passes, dedupe) ───
fetch_vulnerabilities() {
  local name="$1" vulnerable_id="$2"
  local merged="{}"
  for severity in $VULN_SEVERITIES; do
    for pass in 1 2; do
      local body
      body=$(api_request "/vulnerabilities" "vulnerableId=$vulnerable_id&severity=$severity&limit=$VULN_PAGE_SIZE")
      local rows
      rows=$(extract_rows "$body")
      if [[ -z "$rows" ]] || [[ "$rows" = "null" ]]; then
        continue
      fi
      for row in $(echo "$rows" | jq -c '.[]?'); do
        [[ -z "$row" ]] && continue
        merged=$(echo "$merged" "$row" | jq -s '.[1] as $r | if $r.id then .[0] + {($r.id): $r} else .[0] end')
      done
      # If no rows, no point in second pass for this severity
      local cnt
      cnt=$(echo "$rows" | jq 'length')
      [[ "$cnt" -eq 0 ]] && break
    done
  done
  echo "$merged" | jq '[.[] | select(. != null)]'
}

# ─── Main ────────────────────────────────────────────────────────
main() {
  local env_path
  env_path=$(load_env)
  BASE_URL="${API_BASE_URL:-}"
  API_KEY="${API_KEY:-}"

  # Parse args
  local datasets_filter="" exclude_filter="" output_dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --datasets) datasets_filter="$2"; shift 2 ;;
      --exclude)  exclude_filter="$2"; shift 2 ;;
      --output|-o) output_dir="$2"; shift 2 ;;
      --check-env)
        echo "[check-env] .env path: ${env_path:-(not found)}"
        echo "[check-env] API_BASE_URL: ${BASE_URL:-(empty)}"
        echo "[check-env] API_KEY: $([ -n "$API_KEY" ] && echo "ok ${API_KEY:0:4}...${API_KEY: -2}" || echo "(empty)")"
        echo "[check-env] STRICT_SSL: ${STRICT_SSL:-true}"
        echo "[check-env] CA_CERT_PATH: ${CA_CERT_PATH:-(not set)}"
        return 0
        ;;
      *) shift ;;
    esac
  done

  if [[ -z "$BASE_URL" ]] || [[ -z "$API_KEY" ]]; then
    echo "Error: API_BASE_URL and API_KEY required (set in .env or environment)" >&2
    exit 1
  fi
  BASE_URL="${BASE_URL%/}"

  if ! command -v curl &>/dev/null; then
    echo "Error: curl required" >&2
    exit 1
  fi
  if ! command -v jq &>/dev/null; then
    echo "Error: jq required (install: brew install jq, apt install jq, etc.)" >&2
    exit 1
  fi

  build_curl_opts

  output_dir="${output_dir:-daydiff-export-$(date +%Y-%m-%d)}"
  mkdir -p "$output_dir"
  echo ""
  echo "[fetch] Output: $output_dir"
  echo ""

  # Platform datasets
  while IFS='|' read -r name endpoint; do
    if [[ -n "$datasets_filter" ]]; then
      if [[ ",$datasets_filter," != *",$name,"* ]]; then
        continue
      fi
    fi
    if [[ -n "$exclude_filter" ]]; then
      if [[ ",$exclude_filter," == *",$name,"* ]]; then
        continue
      fi
    fi
    echo "[fetch] $name..."
    local rows
    rows=$(fetch_platform "$name" "$endpoint")
    local out_file="$output_dir/$(sanitize_filename "$name").csv"
    if [[ -n "$rows" ]] && [[ "$rows" != "[]" ]]; then
      echo "$rows" | json_to_csv > "$out_file"
      echo "[fetch] $name: wrote $(echo "$rows" | jq 'length') rows to $out_file"
    else
      echo "[fetch] $name: 0 rows (skipping empty CSV)"
    fi
    echo ""
  done <<< "$PLATFORM_DATASETS"

  # Vulnerability datasets
  while IFS='|' read -r asset_name vulnerable_id; do
    local name="vulns-$asset_name"
    if [[ -n "$datasets_filter" ]]; then
      if [[ ",$datasets_filter," != *",$name,"* ]]; then
        continue
      fi
    fi
    if [[ -n "$exclude_filter" ]]; then
      if [[ ",$exclude_filter," == *",$name,"* ]]; then
        continue
      fi
    fi
    echo "[fetch] $name..."
    local rows
    rows=$(fetch_vulnerabilities "$name" "$vulnerable_id")
    local out_file="$output_dir/$(sanitize_filename "$name").csv"
    if [[ -n "$rows" ]] && [[ "$rows" != "[]" ]]; then
      echo "$rows" | json_to_csv > "$out_file"
      echo "[fetch] $name: wrote $(echo "$rows" | jq 'length') rows to $out_file"
    else
      echo "[fetch] $name: 0 rows (skipping empty CSV)"
    fi
    echo ""
  done <<< "$ASSETS"

  echo "[fetch] Complete. Output in $output_dir"
}

main "$@"
