#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
hook_dir="$root/.githooks"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM

git -C "$temporary" init -q
git -C "$temporary" config user.name 'Hook Test'
git -C "$temporary" config user.email 'hook-test@example.invalid'
git -C "$temporary" config core.hooksPath "$hook_dir"

printf '%s\n' 'clean staged content' > "$temporary/fixture.txt"
git -C "$temporary" add fixture.txt
git -C "$temporary" commit -q -m clean

printf 'stripe_api_key = %s%s\n' 'sk_live_' '51H8QWERTYUIOPASDFGHJKLZXCVBNM123' > "$temporary/fixture.txt"
git -C "$temporary" add fixture.txt
if git -C "$temporary" commit -q -m secret >"$temporary/secret.out" 2>&1; then
  printf '%s\n' 'expected the hook to refuse a staged synthetic access key' >&2
  exit 1
fi

printf '%s\n' 'clean staged content again' > "$temporary/fixture.txt"
git -C "$temporary" add fixture.txt
empty_path="$temporary/empty-path"
mkdir "$empty_path"
if PATH="$empty_path" "$hook_dir/pre-commit" >"$temporary/missing.out" 2>&1; then
  printf '%s\n' 'expected the hook to refuse when gitleaks is unavailable' >&2
  exit 1
fi
if ! grep -q 'gitleaks' "$temporary/missing.out"; then
  printf '%s\n' 'expected the missing-tool refusal to name gitleaks' >&2
  exit 1
fi

git -C "$temporary" commit -q -m clean-again
