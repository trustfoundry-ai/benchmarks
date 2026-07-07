#!/usr/bin/env bash
#
# Container entrypoint for the TrustFoundry Legal Search benchmark suite.
#
# Inputs (all via env):
#   TF_API_KEY         required — TrustFoundry public-search API key
#   BENCHMARK_CONFIG   optional — a config path from configs/benchmarks/
#                                 (relative path without .json), or one of the
#                                 convenience aliases below.
#                                 (default: trustfoundry-legal-search/case-questions-5k)
#                                 Aliases:
#                                   all-200 — run every *-200 config in sequence
#                                   all-5k  — run every *-5k config in sequence
#   RUN_LABEL          optional — short label baked into the run ID (default: manual)
#   OUTPUT_BUNDLE_URI  optional — destination prefix for verified bundles.
#                                 Cloud-agnostic; dispatched by URI scheme:
#                                   gs://...  → gcloud storage cp
#                                   file://  → local cp -r
#                                   /abs/path → local cp -r (treated as file://)
#                                 Each bundle lands under
#                                   $OUTPUT_BUNDLE_URI/<benchmark-family>/<sha7>/<leaf>/
#                                 If unset, bundles stay on the container filesystem.
#   HARNESS_COMMIT_SHA   set    — public benchmarks commit the image was
#                                 built from; stamped into output paths.
#
# Behavior: runs `pnpm benchmark run` + `publish-result` + `verify-result`
# once per resolved config, sequentially.

set -euo pipefail

: "${TF_API_KEY:?TF_API_KEY is required}"
: "${BENCHMARK_CONFIG:=trustfoundry-legal-search/case-questions-5k}"
: "${RUN_LABEL:=manual}"
: "${OUTPUT_BUNDLE_URI:=}"
: "${HARNESS_COMMIT_SHA:=unknown}"

PARALLEL_C=4
SHA7=${HARNESS_COMMIT_SHA:0:7}
DATE=$(date -u +%Y-%m-%d)

# Benchmark family hardcoded for this suite. Future suites (legal-judgment,
# etc.) ship as separate Dockerfiles + entrypoints with their own family.
BENCHMARK_FAMILY=trustfoundry-legal-search
PROVIDER_CFG=configs/providers/trustfoundry-legal-search.json

# Configs are discovered from disk so this list stays in sync with the
# committed configs/benchmarks/ tree instead of drifting whenever a new
# config is added. Only *-200.json and *-5k.json are surfaced — these are
# the size suffixes the all-200 / all-5k aliases refer to.
ALL_CONFIGS=()
while IFS= read -r cfg_path; do
  # Strip leading "configs/benchmarks/" and trailing ".json" to get the
  # logical id the rest of this script (and the GHA dropdown) uses.
  cfg_id="${cfg_path#configs/benchmarks/}"
  cfg_id="${cfg_id%.json}"
  ALL_CONFIGS+=("$cfg_id")
done < <(find configs/benchmarks -type f \( -name '*-200.json' -o -name '*-5k.json' \) | sort)

if [ "${#ALL_CONFIGS[@]}" -eq 0 ]; then
  echo "No *-200.json / *-5k.json configs found under configs/benchmarks/" >&2
  exit 2
fi

declare -a CONFIGS_TO_RUN=()
case "$BENCHMARK_CONFIG" in
  all-200)
    for cfg in "${ALL_CONFIGS[@]}"; do
      [[ "$cfg" == *-200 ]] && CONFIGS_TO_RUN+=("$cfg")
    done
    ;;
  all-5k)
    for cfg in "${ALL_CONFIGS[@]}"; do
      [[ "$cfg" == *-5k ]] && CONFIGS_TO_RUN+=("$cfg")
    done
    ;;
  *)
    found=0
    for cfg in "${ALL_CONFIGS[@]}"; do
      [[ "$cfg" == "$BENCHMARK_CONFIG" ]] && { found=1; break; }
    done
    if [ "$found" -ne 1 ]; then
      echo "Unknown BENCHMARK_CONFIG: '$BENCHMARK_CONFIG'" >&2
      echo "Valid: all-200, all-5k, ${ALL_CONFIGS[*]}" >&2
      exit 2
    fi
    CONFIGS_TO_RUN+=("$BENCHMARK_CONFIG")
    ;;
esac

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

echo "benchmarks entrypoint"
echo "  HARNESS_COMMIT_SHA=${HARNESS_COMMIT_SHA}"
echo "  BENCHMARK_CONFIG=${BENCHMARK_CONFIG}"
echo "  RUN_LABEL=${RUN_LABEL}"
echo "  OUTPUT_BUNDLE_URI=${OUTPUT_BUNDLE_URI:-(unset — local only)}"
echo "  Resolved configs: ${CONFIGS_TO_RUN[*]}"

for cfg in "${CONFIGS_TO_RUN[@]}"; do
  bench_cfg_path="configs/benchmarks/${cfg}.json"
  if [ ! -f "$bench_cfg_path" ]; then
    echo "Benchmark config not found: $bench_cfg_path" >&2
    exit 2
  fi

  # Pattern: trustfoundry-legal-search/<type>-<size>
  # where <type> is case-questions|key-facts|laws|regs and
  # <size> is 200|5k.
  if [[ "$cfg" =~ ^trustfoundry-legal-search/(.+)-(200|5k)$ ]]; then
    type_slug="${BASH_REMATCH[1]}"
    size="${BASH_REMATCH[2]}"
  else
    echo "Cannot parse config name '$cfg' (expected trustfoundry-legal-search/<type>-<size>)" >&2
    exit 2
  fi

  # Bundle path layout: results/<benchmark>/<date>/<type>/<size>/
  # Provider identity lives inside the bundle's manifest, not the
  # path.
  run_dir_leaf="${cfg#trustfoundry-legal-search/}"
  run_dir="runs/trustfoundry-legal-search-${run_dir_leaf}"
  bundle_dir="results/trustfoundry-legal-search/${DATE}/${type_slug}/${size}"

  echo
  echo "=== ${cfg} ==="

  pnpm benchmark run \
    --benchmark-config "$bench_cfg_path" \
    --provider-config "$PROVIDER_CFG" \
    --out "$run_dir" \
    --parallel "$PARALLEL_C" \
    --force

  pnpm benchmark publish-result \
    --run "$run_dir" \
    --out "$bundle_dir" \
    --force

  pnpm benchmark verify-result "$bundle_dir"

  if [ -n "$OUTPUT_BUNDLE_URI" ]; then
    # Encode the model type into the leaf dir so multiple sibling bundles
    # from one all-200/all-5k run cluster under <benchmark-family>/<sha7>/
    # without colliding.
    upload_leaf="${DATE}-${RUN_LABEL}-${size}-${type_slug}"
    dest="${OUTPUT_BUNDLE_URI%/}/${BENCHMARK_FAMILY}/${SHA7}/${upload_leaf}/"
    echo "uploading ${bundle_dir}/ -> ${dest}"
    upload_bundle "$bundle_dir" "$dest"
  fi
done

echo
echo "benchmarks entrypoint done"
