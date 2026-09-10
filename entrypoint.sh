#!/usr/bin/env bash
#
# Container entrypoint for the TrustFoundry benchmark suites.
#
# Inputs (all via env):
#   TF_API_KEY         required — TrustFoundry public-search API key
#   BENCHMARK_CONFIG   optional — which target(s) to run. One of:
#                                   <suite>/<target>  a single target
#                                   <suite>/all       every target in one suite
#                                   all               every target in every suite
#                                 Run `pnpm benchmark targets` for the full,
#                                 current list of suites and targets.
#                                 (default: trustfoundry-legal-search/case-questions-5k)
#   RUN_LABEL          optional — short label baked into the run ID (default: manual)
#   OUTPUT_BUNDLE_URI  optional — destination prefix for verified bundles.
#                                 Cloud-agnostic; dispatched by URI scheme:
#                                   gs://...  → gcloud storage cp
#                                   file://  → local cp -r
#                                   /abs/path → local cp -r (treated as file://)
#                                 Each bundle lands under
#                                   $OUTPUT_BUNDLE_URI/<suite>/<sha7>/<date>-<run-label>-<target>/
#                                 If unset, bundles stay on the container filesystem.
#   DRY_RUN            optional — resolve and print every target that would
#                                 run, then exit without running anything.
#   HARNESS_COMMIT_SHA   set    — public benchmarks commit the image was
#                                 built from; stamped into output paths.
#
# Every target's benchmark, provider, and scorer config paths come from the
# suite registry (`suites/<suite>/suite.json`, read through `resolve-target`),
# so adding a suite or a target needs no change to this script.
#
# Behavior: runs `pnpm benchmark run` + `publish-result` + `verify-result`
# once per resolved target, sequentially.

set -euo pipefail

: "${TF_API_KEY:?TF_API_KEY is required}"
: "${BENCHMARK_CONFIG:=trustfoundry-legal-search/case-questions-5k}"
: "${RUN_LABEL:=manual}"
: "${OUTPUT_BUNDLE_URI:=}"
: "${DRY_RUN:=}"
: "${HARNESS_COMMIT_SHA:=unknown}"

PARALLEL_C=4
SHA7=${HARNESS_COMMIT_SHA:0:7}
DATE=$(date -u +%Y-%m-%d)

# Holds one resolve-target call's stderr so it can be inspected before
# being echoed — see the resolve-target failure handling below.
resolve_err_file=$(mktemp)
trap 'rm -f "$resolve_err_file"' EXIT

# The machine-readable target list, captured once: exactly one
# <suite>/<target> per line, nothing else — used to build `all` and
# `<suite>/all`. This is `targets --ids`, not the human `targets` listing,
# so a future change to that listing's prose or indentation can't change
# what a run actually resolves to.
all_ids_output=$(node bin/benchmarks.mjs targets --ids)
declare -a ALL_TARGET_IDS=()
while IFS= read -r id; do
  [ -n "$id" ] && ALL_TARGET_IDS+=("$id")
done <<<"$all_ids_output"

# The human `targets` listing, captured once. Shown on a resolution
# failure that turns out to be an unrecognized id, so a typo's error
# message doesn't leave the reader guessing at what else is valid.
print_valid_targets() {
  echo "Valid targets:" >&2
  node bin/benchmarks.mjs targets >&2
}

declare -a TARGETS=()
case "$BENCHMARK_CONFIG" in
  all)
    TARGETS=("${ALL_TARGET_IDS[@]}")
    if [ "${#TARGETS[@]}" -eq 0 ]; then
      echo "No targets found in the suite registry." >&2
      exit 1
    fi
    ;;
  */all)
    suite="${BENCHMARK_CONFIG%/all}"
    for id in "${ALL_TARGET_IDS[@]}"; do
      [[ "$id" == "${suite}/"* ]] && TARGETS+=("$id")
    done
    if [ "${#TARGETS[@]}" -eq 0 ]; then
      echo "Unknown suite '${suite}'." >&2
      print_valid_targets
      exit 1
    fi
    ;;
  *)
    TARGETS=("$BENCHMARK_CONFIG")
    ;;
esac

echo "benchmarks entrypoint"
echo "  HARNESS_COMMIT_SHA=${HARNESS_COMMIT_SHA}"
echo "  BENCHMARK_CONFIG=${BENCHMARK_CONFIG}"
echo "  RUN_LABEL=${RUN_LABEL}"
echo "  OUTPUT_BUNDLE_URI=${OUTPUT_BUNDLE_URI:-(unset — local only)}"
echo "  Resolved targets: ${TARGETS[*]}"

# Dispatches an upload of a local directory's contents to a destination URI,
# choosing the appropriate tool based on the URI scheme.
upload_bundle() {
  local src_dir="$1"
  local dest_uri="$2"
  case "$dest_uri" in
    gs://*)
      gcloud storage cp -r "${src_dir}"/* "$dest_uri"
      ;;
    file://*)
      local dest_path="${dest_uri#file://}"
      mkdir -p "$dest_path"
      cp -r "${src_dir}"/* "$dest_path"
      ;;
    /*)
      # Treat absolute paths as file:// for convenience.
      mkdir -p "$dest_uri"
      cp -r "${src_dir}"/* "$dest_uri"
      ;;
    *)
      echo "Unsupported OUTPUT_BUNDLE_URI scheme: ${dest_uri}" >&2
      echo "Supported: gs://, file://, /absolute/path" >&2
      return 1
      ;;
  esac
}

for target in "${TARGETS[@]}"; do
  # resolve-target is the single source of truth for whether a target is
  # runnable — its config paths are checked against disk, not just the
  # manifest. On failure it prints an actionable message of its own to
  # stderr and prints nothing to stdout; this script always relays that
  # message verbatim rather than trying to parse or improve on its prose.
  #
  # It appends the full target listing only when the message names an
  # unrecognized suite or target id (resolveTarget's "Unknown suite ..." /
  # "Unknown target ..." — the one case where "here's everything valid" is
  # actually the missing piece). Any other resolve failure — e.g. a config
  # path missing on disk, or a malformed suite.json — is already a
  # complete, actionable message on its own, and dumping every suite and
  # target on top of it would bury the real problem in noise instead of
  # explaining it.
  if ! resolved_json=$(node bin/benchmarks.mjs resolve-target "$target" --json 2>"$resolve_err_file"); then
    resolve_err=$(cat "$resolve_err_file")
    printf '%s\n' "$resolve_err" >&2
    if [[ "$resolve_err" =~ ^Unknown\ (suite|target)\ \' ]]; then
      echo >&2
      print_valid_targets
    fi
    exit 1
  fi

  fields=$(printf '%s' "$resolved_json" | node -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const r = JSON.parse(body);
      process.stdout.write([r.benchmarkConfig, r.providerConfig, r.scorerConfig, r.bundle].join("\t"));
    });
  ')
  IFS=$'\t' read -r bench_cfg prov_cfg scorer_cfg bundle <<<"$fields"
  suite="${target%%/*}"

  echo
  echo "=== ${target} ==="
  echo "  benchmark=${bench_cfg}"
  echo "  provider=${prov_cfg}"
  echo "  scorer=${scorer_cfg}"

  if [ -n "$DRY_RUN" ]; then
    continue
  fi

  run_dir="runs/${suite}-${bundle}"
  # Flat layout: results/<suite>/<date>/<bundle>/ — `bundle` is the
  # target id itself, so it is already unique within its suite.
  bundle_dir="results/${suite}/${DATE}/${bundle}"

  pnpm benchmark run \
    --benchmark-config "$bench_cfg" \
    --provider-config "$prov_cfg" \
    --scorer-config "$scorer_cfg" \
    --out "$run_dir" \
    --parallel "$PARALLEL_C" \
    --force

  pnpm benchmark publish-result \
    --run "$run_dir" \
    --out "$bundle_dir" \
    --force

  pnpm benchmark verify-result "$bundle_dir"

  if [ -n "$OUTPUT_BUNDLE_URI" ]; then
    # <suite> in the parent segment plus <bundle> (the target id, unique
    # within its suite) in the leaf keeps two targets from colliding
    # whether they come from the same suite or different ones in an
    # `all` / `<suite>/all` run.
    upload_leaf="${DATE}-${RUN_LABEL}-${bundle}"
    dest="${OUTPUT_BUNDLE_URI%/}/${suite}/${SHA7}/${upload_leaf}/"
    echo "uploading ${bundle_dir}/ -> ${dest}"
    upload_bundle "$bundle_dir" "$dest"
  fi
done

echo
echo "benchmarks entrypoint done"
