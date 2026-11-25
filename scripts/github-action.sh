#!/usr/bin/env bash
# AgentOps quality gate for GitHub Actions. Called by action.yml; runnable
# locally for testing by setting the same environment variables.
#
# Inputs (environment):
#   AGENTOPS_BIN          agentops executable (required)
#   AGENTOPS_ARTIFACTS    newline/space-separated artifact paths or globs (required;
#                         an empty value is reported as a failed gate)
#   AGENTOPS_CONFIG       config path (default: agentops.config.json)
#   AGENTOPS_FAIL_ON_GATE "true" (default) exits 1 when any gate fails
#   AGENTOPS_REPORT_DIR   where to write gate comments (default: $RUNNER_TEMP or $TMPDIR)
#   AGENTOPS_COMMENT_KEY  optional key for a separate sticky comment (letters,
#                         digits, `.`, `_`, `-`; at most 64 characters)
#   GITHUB_STEP_SUMMARY, GITHUB_OUTPUT  set by the runner; optional locally
set -euo pipefail

# The report's first line is the sticky comment's marker. Each key gets its own
# marker, and no marker is a prefix of another, so keyed comments and the
# default comment never match each other.
comment_key="${AGENTOPS_COMMENT_KEY-}"
marker='<!-- agentops-gate -->'
if [ -n "$comment_key" ]; then
  if ! [[ "$comment_key" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    echo "::error::comment-key must be 1 to 64 letters, digits, dots, underscores or hyphens."
    exit 1
  fi
  marker="<!-- agentops-gate:$comment_key -->"
fi

bin="${AGENTOPS_BIN:?AGENTOPS_BIN is required}"
config="${AGENTOPS_CONFIG:-agentops.config.json}"
fail_on_gate="${AGENTOPS_FAIL_ON_GATE:-true}"
report_base="${AGENTOPS_REPORT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
mkdir -p "$report_base"
# A fresh directory per run, so a second use of the action in the same job
# cannot overwrite an earlier step's report output.
report_dir="$(mktemp -d "$report_base/agentops-gate.XXXXXX")"
combined="$report_dir/agentops-gate-comment.md"

# Expand globs; keep unmatched patterns so a missing file is reported, not
# skipped. Split the input with globbing off: expanding it here, with nullglob
# on, would drop an unmatched pattern before the loop could keep it.
set -f
# shellcheck disable=SC2206 # intentional word splitting; globbing is off
patterns=(${AGENTOPS_ARTIFACTS-})
set +f
shopt -s nullglob
artifacts=()
for pattern in ${patterns[@]+"${patterns[@]}"}; do
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
printf '%s\n' "$marker" >> "$combined"

gate_failed() {
  # $1 = artifact path (from the workflow input), $2 = reason (fixed text)
  echo "::error::AgentOps gate failed: $1 ($2)"
  status="failed"
  failed=$((failed + 1))
}

# An input that resolves to no paths is a failure, reported like any other so
# that the status output and report exist when enforcement is deferred.
if [ ${#artifacts[@]} -eq 0 ]; then
  gate_failed "(empty artifacts input)" "the artifacts input resolved to no paths"
  printf '\n## AgentOps Quality Gate\n\n**Status:** FAILED\n\nThe artifacts input resolved to no paths.\n' >> "$combined"
fi

# Artifacts are untrusted. Nothing derived from their content (such as the
# session id) is used in a file path, a command argument, or stdout, where it
# could traverse paths or inject workflow commands. Each artifact gets its own
# throwaway database outside the checkout, so `check latest` is unambiguous.
index=0
for artifact in ${artifacts[@]+"${artifacts[@]}"}; do
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
