#!/usr/bin/env bash
# Checks the verdict gate in claude-code-review.yml: what the post job accepts
# from verdict.json and what it posts, which reviews it dismisses, and what the
# merge job merges on. Run it after editing either job:
# ./.github/test-verdict-gate.sh
#
# verdict.json is written by the model, so it is untrusted input. The post job
# must rebuild the review from the fields it names and take the commit from the
# event, whatever the file says; the merge job must act on the one verdict post
# checked and nothing else. Several cases below are the abuse cases: a forged
# commit, an extra pull request number, APPROVE.
#
# Each step's own run: script is read out of the workflow and executed with gh
# stubbed, so this checks the shell and its quoting as the runner sees them, not
# a copy of the filter.
set -uo pipefail
cd "$(dirname "$0")/.."
F=.github/workflows/claude-code-review.yml

block() { awk -v n="$1" '$0 ~ "name: "n {f=1} f && /run: \|/ {p=1; next} p && /^ {0,9}[^ ]/ {exit} p {sub(/^          /,""); print}' "$F"; }
POST=$(block "Check the verdict and post it"); MERGE=$(block "Merge what the review found clean")
[ -n "$POST" ] && [ -n "$MERGE" ] || { echo "FAIL: a step was not found in the workflow"; exit 1; }

# The stub records every write in $OUT/log and serves reads from the fixtures:
# $LIST (the pull request's reviews), $FILES (the changed files), $BEHIND (how
# far behind the base) and $REFS (the issues the pull request closes, one
# "owner/repo number" per line). $FAIL_CLOSE makes closing that issue number
# fail, $FAIL_LOOKUP makes the issue lookup fail, $FAIL_CHECKS makes the wait
# for the base branch's required checks fail, and $FAIL_DISPATCH makes starting
# CI fail.
gh() { case $1 in
    pr) if [ "$2" = checks ]; then [ -z "${FAIL_CHECKS:-}" ]; return; fi
        [ -n "${FAIL_LOOKUP:-}" ] && return 1; printf '%s' "${REFS:-}"; return;;
    issue) [ "${FAIL_CLOSE:-}" = "$3" ] && return 1; echo "close $5#$3" >> "$OUT/log"; return;;
    workflow) echo "$*" >> "$OUT/log"; [ -z "${FAIL_DISPATCH:-}" ]; return;;
  esac
  local q= path= input= args="$*"; while [ $# -gt 0 ]; do case $1 in --jq) q=$2; shift 2;; --input) input=$2; shift 2;; -X|-f|--repo) shift 2;; api|--paginate|--silent) shift;; *) path=$1; shift;; esac; done
  case $path in
    */update-branch) echo "update" >> "$OUT/log";;
    */dismissals) echo "dismiss ${path%/dismissals}" | sed 's#.*/#dismiss #' >> "$OUT/log";;
    */reviews) if [ -n "$input" ]; then cp "$input" "$OUT/posted.json"; echo "post" >> "$OUT/log"; echo 42; else jq -r "$q" <<<"$LIST"; fi;;
    */files) echo "$FILES";;
    */compare/*) echo "${BEHIND:-0}";;
    */merge) grep -q 'sha=abc123' <<<"$args" && echo "merge pinned" >> "$OUT/log" || echo "merge UNPINNED" >> "$OUT/log";;
  esac; }
export -f gh
export PR=1 REPO=o/r BASE=master HEAD=b HEAD_SHA=abc123

fail=0
check() { if eval "$2"; then echo "ok:   $1"; else echo "FAIL: $1"; fail=1; fi; }

# A pull request can commit a verdict.json of its own; the review job must
# remove it before the model runs, or a run whose model writes nothing would
# hand on the author's verdict instead of failing.
rm_line=$(grep -n -A1 'name: Remove any verdict the pull request carries' "$F" | grep 'run: rm -f verdict.json$' | cut -d- -f1)
review_line=$(grep -n 'name: Review$' "$F" | cut -d: -f1)
check "review: a verdict.json in the pull request is removed before the model runs" \
  '[ -n "$rm_line" ] && [ -n "$review_line" ] && [ "$rm_line" -lt "$review_line" ]'

# post: $1 name, $2 verdict.json content ("" means no file), $3 reviews list.
post() { export OUT; OUT=$(mktemp -d); export GITHUB_OUTPUT=$OUT/out LIST=${3:-[]}; : > "$OUT/log"
  [ -n "$2" ] && printf '%s' "$2" > "$OUT/verdict.json"
  (cd "$OUT" && bash -c "$POST") >/dev/null 2>&1; echo $? > "$OUT/rc"; }

post x '{"event":"COMMENT","body":"clean","comments":[]}'
check "post: a clean verdict is posted, on the event's commit, and called clean" '[ "$(cat $OUT/rc)" = 0 ] && grep -qx post $OUT/log && [ "$(jq -r .commit_id $OUT/posted.json)" = abc123 ] && grep -qx "clean=true" $OUT/out'
post x '{"event":"COMMENT","body":"ok","comments":[{"path":"a","line":1,"side":"RIGHT","body":"x"}]}'
check "post: a comment carrying inline findings is posted, not clean" 'grep -qx post $OUT/log && grep -qx "clean=false" $OUT/out'
post x '{"event":"REQUEST_CHANGES","body":"no","comments":[]}'
check "post: a request for changes is posted, not clean" 'grep -qx post $OUT/log && grep -qx "clean=false" $OUT/out'
post x '{"event":"COMMENT","body":"ok","commit_id":"evil","pull_number":999,"comments":[{"path":"a","line":1,"side":"RIGHT","body":"x","position":5,"commit_id":"evil"}]}'
check "post: a forged commit and extra keys are dropped" '[ "$(jq -c "keys" $OUT/posted.json)" = "[\"body\",\"comments\",\"commit_id\",\"event\"]" ] && [ "$(jq -r .commit_id $OUT/posted.json)" = abc123 ] && [ "$(jq -c ".comments[0]|keys" $OUT/posted.json)" = "[\"body\",\"line\",\"path\",\"side\"]" ]'
post x '{"event":"APPROVE","body":"lgtm"}'
check "post: APPROVE fails the run and posts nothing" '[ "$(cat $OUT/rc)" != 0 ] && ! grep -q post $OUT/log'
post x '{"event":"COMMENT","body":""}'
check "post: an empty body fails the run and posts nothing" '[ "$(cat $OUT/rc)" != 0 ] && ! grep -q post $OUT/log'
post x 'not json'
check "post: a file that is not JSON fails and posts nothing" '[ "$(cat $OUT/rc)" != 0 ] && ! grep -q post $OUT/log'
post x ''
check "post: no verdict.json fails and posts nothing" '[ "$(cat $OUT/rc)" != 0 ] && ! grep -q post $OUT/log'
post x '{"event":"REQUEST_CHANGES","body":"no"}' '[{"id":7,"user":{"login":"github-actions[bot]"},"state":"CHANGES_REQUESTED"},{"id":8,"user":{"login":"nomadwiz"},"state":"CHANGES_REQUESTED"},{"id":9,"user":{"login":"claude[bot]"},"state":"CHANGES_REQUESTED"},{"id":42,"user":{"login":"github-actions[bot]"},"state":"CHANGES_REQUESTED"}]'
check "post: posts first, then dismisses old bot blocks, never the new one or a person's" '[ "$(tr "\n" " " < $OUT/log)" = "post dismiss 7 dismiss 9 " ]'

# merge: $1 what post said (CLEAN), $2 changed files. BEHIND, REFS, FAIL_CLOSE
# and FAIL_LOOKUP are read from the environment; $OUT/rc is the exit status.
merge() { export OUT; OUT=$(mktemp -d); : > "$OUT/log"; export CLEAN=$1 FILES=$2
  bash -c "$MERGE" >/dev/null 2>&1; echo $? > "$OUT/rc"; }

merge true src/x.ts
check "merge: a clean verdict merges, pinned to the reviewed commit, then starts CI on the base" '[ "$(tr "\n" " " < $OUT/log)" = "merge pinned workflow run ci.yml -R o/r --ref master " ]'
merge false src/x.ts
check "merge: a verdict that is not clean holds" '[ ! -s $OUT/log ]'
merge "" src/x.ts
check "merge: no verdict from post holds" '[ ! -s $OUT/log ]'
merge true .github/workflows/claude-code-review.yml
check "merge: a workflow change is left for a person" '[ ! -s $OUT/log ]'
export BEHIND=3
merge true src/x.ts
check "merge: a clean branch that is behind is left for Update branch, not updated or merged" '[ ! -s $OUT/log ]'
unset BEHIND
export REFS=$'o/r 5\nnomadwiz/stop-signal 7'
merge true src/x.ts
check "merge: after merging, closes every issue the pull request names" '[ "$(tr "\n" " " < $OUT/log)" = "merge pinned close o/r#5 close nomadwiz/stop-signal#7 workflow run ci.yml -R o/r --ref master " ] && [ "$(cat $OUT/rc)" = 0 ]'
export FAIL_CLOSE=5
merge true src/x.ts
check "merge: an issue that will not close is skipped, and the rest still close" '[ "$(tr "\n" " " < $OUT/log)" = "merge pinned close nomadwiz/stop-signal#7 workflow run ci.yml -R o/r --ref master " ] && [ "$(cat $OUT/rc)" = 0 ]'
unset FAIL_CLOSE
merge false src/x.ts
check "merge: nothing is closed when nothing merges" '[ ! -s $OUT/log ]'
unset REFS
export FAIL_LOOKUP=1
merge true src/x.ts
check "merge: a failed issue lookup still leaves the merge done and the job green" '[ "$(tr "\n" " " < $OUT/log)" = "merge pinned workflow run ci.yml -R o/r --ref master " ] && [ "$(cat $OUT/rc)" = 0 ]'
unset FAIL_LOOKUP
export FAIL_CHECKS=1
merge true src/x.ts
check "merge: a required check that fails holds the merge" '[ ! -s $OUT/log ] && [ "$(cat $OUT/rc)" = 0 ]'
unset FAIL_CHECKS
export FAIL_DISPATCH=1
merge true src/x.ts
check "merge: CI that will not start fails the job, after the merge" '[ "$(tr "\n" " " < $OUT/log)" = "merge pinned workflow run ci.yml -R o/r --ref master " ] && [ "$(cat $OUT/rc)" != 0 ]'
unset FAIL_DISPATCH
exit $fail
