#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
	cat >&2 <<'EOF'
usage: bash scripts/release.sh [patch|minor|major|X.Y.Z]
  no arg = interactive prompt (pick from the list or type X.Y.Z yourself)
EOF
}

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
	if [ ! -t 0 ]; then
		usage
		exit 2
	fi
	echo "select a version bump:"
	select choice in patch minor major "X.Y.Z (custom)"; do
		case "$choice" in
			patch | minor | major) BUMP="$choice" ;;
			"X.Y.Z (custom)") read -rp "version (X.Y.Z): " BUMP ;;
			*) echo "pick 1-4" >&2 ;;
		esac
		[ -n "$BUMP" ] && break
	done
fi

case "$BUMP" in
	patch | minor | major) ;;
	*)
		if ! [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			echo "✗ invalid bump \"$BUMP\" — must be patch|minor|major|X.Y.Z" >&2
			usage
			exit 2
		fi
		;;
esac

if [ -n "$(git status --porcelain)" ]; then
	echo "✗ working tree is not clean — commit/stash before releasing:" >&2
	git status --short >&2
	exit 1
fi

echo "▸ running tests…"
npm test

if ! npm whoami >/dev/null 2>&1; then
	echo "▸ npm login required…"
	npm login
fi
echo "▸ npm user: $(npm whoami)"

NEW=$(npm version "$BUMP" -m "release %s")
echo "▸ bumped → $NEW (commit+tag created)"
git push --follow-tags
npm publish

echo "✅ released $NEW — commit+tag pushed and published to npm"
