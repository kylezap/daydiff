#!/usr/bin/env bash
#
# Export application vulnerabilities with status "detected" to CSV.
#
# Optimized for large result sets (~25k–30k rows): single API filter (status=detected),
# stream-to-file (constant memory), and larger page size to minimize round-trips.
#
# Usage:
#   ./export-vulns-detected.sh
#   ./export-vulns-detected.sh --asset "Digital One Flex (17040)"
#   ./export-vulns-detected.sh --vulnerable-id <uuid>
#   ./export-vulns-detected.sh --output ./detected-vulns.csv --page-size 1000
#
# Requires: curl, jq.  .env with API_BASE_URL and API_KEY.
#
# If your API uses a different query param for status (e.g. statuses=detected),
# set VULN_STATUS_PARAM in .env or pass --status-param "statuses=detected".
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Larger page size = fewer requests for 25k–30k records (e.g. 1000 → ~30 requests)
PAGE_SIZE="${PAGE_SIZE:-1000}"
MAX_ITERATIONS=2000

# Assets: name|vulnerableId (must match config/assets.mjs)
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

# ─── Build curl args (proxy, CA, SSL) ─────────────────────────────
build_curl_opts() {
  CURL_OPTS=(-sS -w "\n%{http_code}" --max-time 120)
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

  local attempt=1
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

# ─── Extract rows from API response ───────────────────────────────
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

# ─── Write CSV header from key array (JSON array of strings) ────────
write_csv_header() {
  echo "$1" | jq -r '@csv'
}

# ─── Write CSV rows from JSON array using fixed key order ───────────
# Keys must be JSON array of strings from first page.
write_csv_rows() {
  local keys="$1" rows="$2"
  echo "$rows" | jq -r --argjson keys "$keys" '
    def to_csv_val:
      if . == null then ""
      elif type == "object" or type == "array" then @json
      else tostring end;
    (.[] | [.[$keys[]] | to_csv_val] | @csv)
  '
}

# ─── Fetch detected vulnerabilities for one asset, stream to CSV ───
fetch_detected_to_csv() {
  local vulnerable_id="$1" out_file="$2" page_size="$3" status_param="$4"
  local offset=0 total=0 keys="" iter=1

  # First request: get total and first page
  local first_query="vulnerableId=${vulnerable_id}&${status_param}&limit=${page_size}&offset=0"
  local first_body
  first_body=$(api_request "/vulnerabilities" "$first_query") || return 1

  local first_rows
  first_rows=$(extract_rows "$first_body")
  local pag
  pag=$(extract_pagination "$first_body")
  total="${pag%%|*}"

  local count
  count=$(echo "$first_rows" | jq 'length')
  if [[ "$count" -eq 0 ]]; then
    echo "[fetch] 0 records with status=detected (empty CSV)" >&2
    printf 'id\n' > "$out_file"
    return 0
  fi

  keys=$(echo "$first_rows" | jq -c '.[0] | keys')
  {
    write_csv_header "$keys"
    write_csv_rows "$keys" "$first_rows"
  } > "$out_file"

  echo "[fetch] $total total, page size $page_size, streaming to $out_file" >&2
  echo "[fetch] 1/$total rows written" >&2

  offset=$page_size
  while [[ $offset -lt $total ]] && [[ $iter -lt $MAX_ITERATIONS ]]; do
    local page_query="vulnerableId=${vulnerable_id}&${status_param}&limit=${page_size}&offset=${offset}"
    local page_body
    page_body=$(api_request "/vulnerabilities" "$page_query") || return 1
    local page_rows
    page_rows=$(extract_rows "$page_body")
    local page_count
    page_count=$(echo "$page_rows" | jq 'length')
    if [[ -z "$page_rows" ]] || [[ "$page_rows" = "null" ]] || [[ "$page_count" -eq 0 ]]; then
      break
    fi
    write_csv_rows "$keys" "$page_rows" >> "$out_file"
    offset=$((offset + page_count))
    local written
    written=$((offset < total ? offset : total))
    if [[ $((iter % 5)) -eq 0 ]] || [[ $offset -ge $total ]]; then
      echo "[fetch] $written/$total rows written" >&2
    fi
    [[ "$page_count" -lt "$page_size" ]] && break
    ((iter++)) || true
  done

  echo "[fetch] Done. Wrote $offset rows to $out_file" >&2
}

# ─── Main ────────────────────────────────────────────────────────
main() {
  local env_path
  env_path=$(load_env)
  BASE_URL="${API_BASE_URL:-}"
  API_KEY="${API_KEY:-}"

  local asset_name="" vulnerable_id="" output_file="" page_size="$PAGE_SIZE"
  local status_param="${VULN_STATUS_PARAM:-status=detected}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --asset)
        asset_name="$2"
        shift 2
        ;;
      --vulnerable-id)
        vulnerable_id="$2"
        shift 2
        ;;
      --output|-o)
        output_file="$2"
        shift 2
        ;;
      --page-size)
        page_size="$2"
        shift 2
        ;;
      --status-param)
        status_param="$2"
        shift 2
        ;;
      --check-env)
        echo "[check-env] .env path: ${env_path:-(not found)}"
        echo "[check-env] API_BASE_URL: ${BASE_URL:-(empty)}"
        echo "[check-env] API_KEY: $([ -n "$API_KEY" ] && echo "ok ${API_KEY:0:4}...${API_KEY: -2}" || echo "(empty)")"
        echo "[check-env] status param: $status_param"
        return 0
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ -z "$BASE_URL" ]] || [[ -z "$API_KEY" ]]; then
    echo "Error: API_BASE_URL and API_KEY required (set in .env or environment)" >&2
    exit 1
  fi
  BASE_URL="${BASE_URL%/}"

  if [[ -z "$vulnerable_id" ]]; then
    if [[ -n "$asset_name" ]]; then
      while IFS='|' read -r name vid; do
        if [[ "$name" = "$asset_name" ]]; then
          vulnerable_id="$vid"
          break
        fi
      done <<< "$ASSETS"
      if [[ -z "$vulnerable_id" ]]; then
        echo "Error: asset not found: $asset_name" >&2
        echo "Available: $(echo "$ASSETS" | cut -d'|' -f1 | tr '\n' ', ')" >&2
        exit 1
      fi
    else
      # Default: first asset
      vulnerable_id=$(echo "$ASSETS" | head -n1 | cut -d'|' -f2)
      asset_name=$(echo "$ASSETS" | head -n1 | cut -d'|' -f1)
    fi
  fi

  if ! command -v curl &>/dev/null; then
    echo "Error: curl required" >&2
    exit 1
  fi
  if ! command -v jq &>/dev/null; then
    echo "Error: jq required (install: brew install jq, apt install jq, etc.)" >&2
    exit 1
  fi

  build_curl_opts

  output_file="${output_file:-vulns-detected-$(date +%Y-%m-%d).csv}"
  echo ""
  fetch_detected_to_csv "$vulnerable_id" "$output_file" "$page_size" "$status_param"
  echo ""
  echo "[fetch] Complete. Output: $output_file"
}

main "$@"
