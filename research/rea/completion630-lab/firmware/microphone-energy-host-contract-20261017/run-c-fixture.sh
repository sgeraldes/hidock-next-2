#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$here/../microphone-energy-cache-20261017"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cc -std=c99 -O2 -Wall -Wextra -Wpedantic -Werror \
  -I "$source_dir" \
  "$source_dir/h1e_voice_energy_reply_v2.c" \
  "$here/c-reply-fixture.c" \
  -o "$tmp_dir/c-reply-fixture"
"$tmp_dir/c-reply-fixture"
