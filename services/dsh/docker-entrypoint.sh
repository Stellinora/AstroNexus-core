#!/usr/bin/env bash
set -euo pipefail

profile="${DSH_PROFILE:-astronexus-web}"
args=(--profile "$profile")

if [[ "$profile" == *-web ]]; then
  args+=(--no-open --host "$(hostname -i | awk '{print $1}')")
  if [[ -n "${DSH_PUBLIC_URL:-}" ]]; then
    args+=(--public-url "$DSH_PUBLIC_URL")
  fi
  if [[ -n "${DSH_TRUSTED_HOST:-}" ]]; then
    args+=(--trusted-host "$DSH_TRUSTED_HOST")
  fi
fi

exec dsh "${args[@]}" "$@"
