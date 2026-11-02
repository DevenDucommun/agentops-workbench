#!/usr/bin/env bash
# AgentOps quality gate for GitHub Actions. Called by action.yml; runnable
# locally for testing by setting the same environment variables.
#
# Inputs (environment):
#   AGENTOPS_BIN          agentops executable (required)
#   AGENTOPS_ARTIFACTS    newline/space-separated artifact paths or globs (required)
#   AGENTOPS_CONFIG       config path (default: agentops.config.json)
#   AGENTOPS_FAIL_ON_GATE "true" (default) exits 1 when any gate fails
#   AGENTOPS_REPORT_DIR   where to write gate comments (default: $RUNNER_TEMP or $TMPDIR)
#   GITHUB_STEP_SUMMARY, GITHUB_OUTPUT  set by the runner; optional locally
set -euo pipefail

bin="${AGENTOPS_BIN:?AGENTOPS_BIN is required}"
config="${AGENTOPS_CONFIG:-agentops.config.json}"
fail_on_gate="${AGENTOPS_FAIL_ON_GATE:-true}"
report_dir="${AGENTOPS_REPORT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}/agentops-gate"
mkdir -p "$report_dir"
combined="$report_dir/agentops-gate-comment.md"

# Expand globs; keep literal paths so a missing file is reported, not skipped.
shopt -s nullglob
artifacts=()
for pattern in ${AGENTOPS_ARTIFACTS:?AGENTOPS_ARTIFACTS is required}; do
  # shellcheck disable=SC2206 # intentional glob expansion of the pattern
  matches=($pattern)
  if [ ${#matches[@]} -eq 0 ]; then
    artifacts+=("$pattern")
  else
    artifacts+=("${matches[@]}")
  fi
done
shopt -u nullglob

status="passed"
failed=0
: > "$combined"
printf '<!-- agentops-gate -->\n' >> "$combined"

for artifact in "${artifacts[@]}"; do
  if [ ! -f "$artifact" ]; then
    echo "::error::AgentOps artifact not found: $artifact"
    status="failed"
    failed=$((failed + 1))
    # shellcheck disable=SC2016 # backticks are literal Markdown
    printf '\n## AgentOps Quality Gate\n\n**Status:** FAILED\n\nArtifact not found: `%s`\n' "$artifact" >> "$combined"
    continue
  fi

  ingest="$("$bin" audit "$artifact" --quiet --config "$config")"
  echo "$ingest"
  session="$(printf '%s\n' "$ingest" | sed -n 's/^Ingested session \([^ ]*\) .*/\1/p' | head -n 1)"
  if [ -z "$session" ]; then
    echo "::error::Could not read the session id from agentops audit output for $artifact"
    exit 1
  fi

  out="$report_dir/gate-$session.md"
  if "$bin" check "$session" --config "$config" --format github --out "$out" > /dev/null; then
    echo "AgentOps gate passed: $artifact ($session)"
  else
    echo "::error::AgentOps gate failed: $artifact ($session)"
    status="failed"
    failed=$((failed + 1))
  fi
  printf '\n' >> "$combined"
  cat "$out" >> "$combined"
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$combined" >> "$GITHUB_STEP_SUMMARY"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "status=$status"
    echo "failed=$failed"
    echo "report=$combined"
  } >> "$GITHUB_OUTPUT"
fi

echo "AgentOps gate: $status (${#artifacts[@]} artifact(s), $failed failed). Report: $combined"
if [ "$status" = "failed" ] && [ "$fail_on_gate" = "true" ]; then
  exit 1
fi
