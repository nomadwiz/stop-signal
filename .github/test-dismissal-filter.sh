#!/usr/bin/env bash
# Checks the jq filter in claude-code-review.yml that picks which reviews to
# dismiss. Run it after editing that filter: ./.github/test-dismissal-filter.sh
#
# The filter decides whether a request-changes review ever clears. Get the login
# or the state wrong and it matches nothing, which looks exactly like a run with
# nothing to dismiss — so the pull request stays blocked and nothing says why.
# That is not hypothetical: the first version matched github-actions[bot] only,
# and the verdict is posted by claude[bot], because the action gives Claude its
# own app token. The fixture below carries both logins, taken from real reviews
# on nomadwiz/kete-doc#27 and nomadwiz/kete#317 rather than from what the filter
# was expected to see.
#
# The filter is read out of the workflow rather than copied here, so there is one
# copy of it and this checks the one the workflow actually runs.
set -euo pipefail
cd "$(dirname "$0")/.."

filter=$(grep -o "\.\[\] | select(.*\.user\.login.*| \.id" .github/workflows/claude-code-review.yml)
[ -n "$filter" ] || { echo "FAIL: no filter found in the workflow"; exit 1; }

got=$(jq -r "$filter" <<'JSON' | tr '\n' ' '
[
  {"id": 111, "state": "CHANGES_REQUESTED", "user": {"login": "github-actions[bot]"}},
  {"id": 222, "state": "DISMISSED",         "user": {"login": "github-actions[bot]"}},
  {"id": 333, "state": "CHANGES_REQUESTED", "user": {"login": "nomadwiz"}},
  {"id": 444, "state": "COMMENTED",         "user": {"login": "github-actions[bot]"}},
  {"id": 555, "state": "CHANGES_REQUESTED", "user": {"login": "github-actions[bot]"}},
  {"id": 666, "state": "CHANGES_REQUESTED", "user": {"login": "claude[bot]"}},
  {"id": 777, "state": "COMMENTED",         "user": {"login": "claude[bot]"}},
  {"id": 888, "state": "DISMISSED",         "user": {"login": "claude[bot]"}}
]
JSON
)

# 111, 555 and 666 are live blocks by either bot. 222 and 888 are already
# dismissed, 333 is a person's and must never be touched, and 444 and 777 are
# the empty-bodied COMMENTED rows GitHub creates for each inline comment — they
# block nothing, and dismissing one would delete a finding.
want="111 555 666 "
[ "$got" = "$want" ] && { echo "ok: filter selects $want"; exit 0; }
echo "FAIL: wanted '$want' got '$got'"
exit 1
