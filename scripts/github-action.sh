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
report_base="${AGENTOPS_REPORT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
mkdir -p "$report_base"
# A fresh directory per run, so a second use of the action in the same job
# cannot overwrite an earlier step's report output.
report_dir="$(mktemp -d "$report_base/agentops-gate.XXXXXX")"
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

gate_failed() {
  # $1 = artifact path (from the workflow input), $2 = reason (fixed text)
  echo "::error::AgentOps gate failed: $1 ($2)"
  status="failed"
  failed=$((failed + 1))
}

# Artifacts are untrusted. Nothing derived from their content (such as the
# session id) is used in a file path, a command argument, or stdout, where it
# could traverse paths or inject workflow commands. Each artifact gets its own
# throwaway database outside the checkout, so `check latest` is unambiguous.
index=0
for artifact in "${artifacts[@]}"; do
  index=$((index + 1))
  if [ ! -f "$artifact" ]; then
    gate_failed "$artifact" "artifact not found"
    # shellcheck disable=SC2016 # backticks are literal Markdown
    printf '\n## AgentOps Quality Gate\n\n**Status:** FAILED\n\nArtifact not found: `%s`\n' "$artifact" >> "$combined"
    continue
  fi

  db="$report_dir/db-$index.sqlite"
  out="$report_dir/gate-$index.md"
  rm -f "$db" "$out"

  if ! AGENTOPS_DB="$db" "$bin" audit "$artifact" --quiet --config "$config" > "$report_dir/audit-$index.log" 2>&1; then
    gate_failed "$artifact" "could not be parsed; see audit-$index.log in the report directory"
    # shellcheck disable=SC2016 # backticks are literal Markdown
    printf '\n## AgentOps Quality Gate\n\n**Status:** FAILED\n\nArtifact could not be parsed: `%s`\n' "$artifact" >> "$combined"
    continue
  fi

  if AGENTOPS_DB="$db" "$bin" check latest --config "$config" --format github --out "$out" > /dev/null 2>&1; then
    echo "AgentOps gate passed: $artifact"
  elif [ -s "$out" ]; then
    gate_failed "$artifact" "quality gate failed"
  else
    gate_failed "$artifact" "agentops check did not produce a report"
    # shellcheck disable=SC2016 # backticks are literal Markdown
    printf '\n## AgentOps Quality Gate\n\n**Status:** FAILED\n\nNo gate report for: `%s`\n' "$artifact" >> "$combined"
    continue
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
