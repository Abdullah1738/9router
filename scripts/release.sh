#!/bin/zsh
# Build and publish a release to the zero-downtime supervisor.
#   release.sh            build (NEXT_DIST_DIR=.next-new), copy standalone into .releases/<id>, switch + reload
#   release.sh --no-build publish the existing .next-new/standalone
#   release.sh --rollback point current back at the previous release and reload
# The supervisor (com.abdullah.9router-fork) reloads on SIGHUP: new worker first,
# old worker drains its in-flight streams, so running sessions are not cut.
set -euo pipefail
ROOT=~/tmp/9router
REL=$ROOT/.releases
LABEL=com.abdullah.9router-fork
source ~/.nvm/nvm.sh >/dev/null; nvm use 26.2.0 >/dev/null
cd $ROOT
mkdir -p $REL

reload() {
  launchctl kill SIGHUP gui/$(id -u)/$LABEL
  echo "SIGHUP sent; watch: tail -f ~/.9router/logs/fork-server.log | grep 9r-"
}

if [[ ${1:-} == --rollback ]]; then
  prev=$(readlink $REL/previous 2>/dev/null) || { echo "no previous release"; exit 1; }
  cur=$(readlink $REL/current)
  ln -sfn $prev $REL/current; ln -sfn $cur $REL/previous
  echo "current -> $prev"; reload; exit 0
fi

if [[ ${1:-} != --no-build ]]; then
  rm -rf .next-new
  NEXT_DIST_DIR=.next-new npm run build
fi
[[ -f .next-new/standalone/custom-server.js ]] || { echo "no standalone build"; exit 1; }
id=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!tmp' || echo -dirty)
cp -c -R .next-new/standalone $REL/$id
if [[ -L $REL/current ]]; then ln -sfn $(readlink $REL/current) $REL/previous; fi
ln -sfn $id $REL/current
echo "current -> $id"
# Keep the five newest releases plus whatever current/previous point at.
keep=($(readlink $REL/current) $(readlink $REL/previous 2>/dev/null || true))
for d in $(ls -1t $REL | grep -v -e '^current$' -e '^previous$' | tail -n +6); do
  (( ${keep[(Ie)$d]} )) || rm -rf $REL/$d
done
reload
