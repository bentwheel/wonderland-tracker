#!/usr/bin/env bash
# Wonderland tracker — post-deploy verification. Cicero runs this and reports the
# full output back to Cameron. It is read-only: it hits endpoints and inspects
# state, it does not change anything. Non-zero exit means at least one check failed.
#
# Usage:
#   ./verify.sh                 # checks the local API on 127.0.0.1:8787
#   BASE=https://cslester.com ./verify.sh   # checks through nginx/public

set -u
BASE="${BASE:-http://127.0.0.1:8787}"
fail=0

echo "== Wonderland tracker verification =="
echo "Base URL: $BASE"
echo

check() {
  local label="$1"; shift
  echo "--- $label"
  if "$@"; then
    echo "    PASS"
  else
    echo "    FAIL"
    fail=1
  fi
  echo
}

# 1. Health endpoint
check "GET /api/health returns ok" bash -c \
  "curl -fsS '$BASE/api/health' | grep -q '\"ok\":true'"

# 2. Current location endpoint responds with expected shape
check "GET /api/location/current has feed_healthy field" bash -c \
  "curl -fsS '$BASE/api/location/current' | grep -q 'feed_healthy'"

# 3. Recent endpoint responds
check "GET /api/location/recent returns a count" bash -c \
  "curl -fsS '$BASE/api/location/recent?hours=24' | grep -q '\"count\"'"

# 4. Photos endpoint responds
check "GET /api/photos returns a count" bash -c \
  "curl -fsS '$BASE/api/photos' | grep -q '\"count\"'"

# 5. Upload rejects an unauthenticated request (expect HTTP 401)
check "POST /admin/upload without token is rejected (401)" bash -c \
  "test \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$BASE/admin/upload')\" = '401'"

# 6. Poller has run at least once (poll_status stamped). Informational.
echo "--- Poller status (informational)"
DB="${TRACKER_DB_PATH:-/opt/wonderland-tracker/data/locations.db}"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB" ]; then
  sqlite3 "$DB" "SELECT 'last_success='||COALESCE(last_success_utc,'never')||' last_error='||COALESCE(last_error,'none') FROM poll_status WHERE id=1;"
  echo "    location rows: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM locations;')"
else
  echo "    (sqlite3 CLI or DB file not available — skipping)"
fi
echo

echo "== Raw current-location payload =="
curl -fsS "$BASE/api/location/current" || echo "(request failed)"
echo
echo

if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "ONE OR MORE CHECKS FAILED — see above."
fi
exit "$fail"
