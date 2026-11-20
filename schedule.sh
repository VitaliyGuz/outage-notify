#!/usr/bin/env bash
# Poltavaoblenergo outage schedule (GPV) for one queue, as JSON.
# Usage: schedule.sh [queue]    (default 3.1)
set -euo pipefail

readonly SOURCE_URL="https://www.poe.pl.ua/customs/dynamicgpv-info.php"
readonly SLOTS_PER_DAY=48

die() {
  echo "$1" >&2
  exit "${2:-1}"
}

# The page header reads "19 листопада 2026 року"; prints 2026-11-19.
schedule_date() {
  local html="$1" dd month yyyy mm
  read -r dd month yyyy _ <<<"$(grep -oE '[0-9]{1,2} [^ <]+ [0-9]{4} року' <<<"$html" | awk 'NR == 1' || true)"
  case "$month" in
    січня) mm=01 ;; лютого) mm=02 ;; березня) mm=03 ;; квітня) mm=04 ;;
    травня) mm=05 ;; червня) mm=06 ;; липня) mm=07 ;; серпня) mm=08 ;;
    вересня) mm=09 ;; жовтня) mm=10 ;; листопада) mm=11 ;; грудня) mm=12 ;;
    *) return 1 ;;
  esac
  printf '%s-%s-%02d\n' "$yyyy" "$mm" "$((10#$dd))"
}

# Prints one "from to status" line per half-hour, status being on / off / maybe.
# Every cell carries title="3.1: 03:00–03:30 — <status text>"; the first SLOTS_PER_DAY are the
# queue's day (the same cells repeat further down in the page's vertical view).
queue_slots() {
  local html="$1" queue="$2"
  grep -oE "title=\"${queue/./\\.}: [^\"]+\"" <<<"$html" \
    | sed -E 's/^title="[^ ]+ ([0-9:]{5})–([0-9:]{5}) — (.*)"$/\1 \2 \3/' \
    | awk -v n="$SLOTS_PER_DAY" 'NR <= n {
        print $1, $2, ($0 ~ /Вимкнено/) ? "off" : ($0 ~ /Увімкнено/) ? "on" : "maybe"
      }'
}

# Reads queue_slots output on stdin. An outage is a run of "off" slots; "may_last_until" is the end
# of the "maybe" slots right after it, which otherwise count as power.
render_json() {
  awk -v queue="$1" -v day="$2" -v src="$SOURCE_URL" '
    { from[NR] = $1; to[NR] = $2; status[NR] = $3 }
    END {
      n = 0
      for (i = 1; i <= NR; i++) {
        if (status[i] != "off") continue
        start = i
        while (i < NR && status[i + 1] == "off") i++
        last = i
        while (last < NR && status[last + 1] == "maybe") last++
        tail = (last > i) ? "\"" to[last] "\"" : "null"
        outage[++n] = sprintf("{\"from\": \"%s\", \"to\": \"%s\", \"may_last_until\": %s}", from[start], to[i], tail)
        i = last
      }
      printf "{\n  \"queue\": \"%s\",\n  \"date\": \"%s\",\n  \"source\": \"%s\",\n", queue, day, src
      printf "  \"outages\": [\n"
      for (i = 1; i <= n; i++) printf "    %s%s\n", outage[i], (i < n ? "," : "")
      printf "  ],\n  \"slots\": [\n"
      for (i = 1; i <= NR; i++)
        printf "    {\"from\": \"%s\", \"to\": \"%s\", \"status\": \"%s\"}%s\n", from[i], to[i], status[i], (i < NR ? "," : "")
      printf "  ]\n}\n"
    }'
}

main() {
  local queue="${1:-3.1}" html day slots count
  [[ "$queue" =~ ^[0-9]\.[0-9]$ ]] || die "usage: $0 [queue], e.g. 3.1" 2

  html="$(curl -fsS --compressed --max-time 30 "$SOURCE_URL")"
  day="$(schedule_date "$html")" || die "cannot read the schedule date"
  slots="$(queue_slots "$html" "$queue" || true)"
  count="$(grep -c . <<<"$slots" || true)"
  ((count == SLOTS_PER_DAY)) || die "queue $queue: expected $SLOTS_PER_DAY half-hour slots, got $count"

  render_json "$queue" "$day" <<<"$slots"
}

main "$@"
