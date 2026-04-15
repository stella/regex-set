#!/bin/bash
# Apply standard Stella repo settings.
# Run: ./scripts/setup-repo.sh stella/repo-name
#
# Settings applied:
# - Squash merge only (no merge commits, no rebase)
# - Delete branch on merge
# - Disable wiki, projects (unused)
# - Enable issues
#
# Branch protection requires GitHub Pro for private
# repos. When repos go public or org upgrades,
# run the branch-protection section below.

set -euo pipefail

REPO="${1:?Usage: setup-repo.sh owner/repo}"

echo "Applying settings to $REPO..."

gh api "repos/$REPO" -X PATCH \
  -f allow_squash_merge=true \
  -f allow_merge_commit=false \
  -f allow_rebase_merge=false \
  -f delete_branch_on_merge=true \
  -F has_wiki=false \
  -F has_projects=false \
  -F has_issues=true \
  --silent

echo "Merge settings: squash-only, delete branch ✓"

# Topics
gh repo edit "$REPO" \
  --add-topic aho-corasick \
  --add-topic napi-rs \
  --add-topic rust \
  --add-topic typescript \
  --add-topic node \
  --add-topic bun 2>/dev/null || true

echo "Topics ✓"

# Labels (sync from org standard)
LABELS=(
  "📦 dependencies:54c778"
  "🧹 refactor:C0A97D"
  "chore:5d0ca4"
  "🛠️  dev:FBCA04"
  "💭 triage:EF4B67"
  "🔥 high_priority:F59FC9"
  "❗ normal_priority:FFBABA"
  "❕low_priority:C5DEF5"
  "🚧 blocked:7C4504"
  "size/XS:009900"
  "size/S:77bb00"
  "size/M:eebb00"
  "size/L:ee9900"
  "size/XL:ee5500"
  "size/XXL:ee0000"
)

for label_spec in "${LABELS[@]}"; do
  name="${label_spec%%:*}"
  color="${label_spec##*:}"
  gh label create "$name" --color "$color" \
    -R "$REPO" 2>/dev/null || true
done

echo "Labels ✓"
echo "Done. Branch protection requires GitHub Pro."
