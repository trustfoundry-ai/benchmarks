#!/usr/bin/env bash
#
# Container entrypoint for the benchmarks harness.
#
# Inputs (all via env):
#   TF_API_KEY         required — TrustFoundry public-search API key
#   MODEL_TYPES        optional — comma-separated subset of:
#                                 case-questions,key-facts,laws,regs
#                                 (default: all four)
#   BENCHMARK_SIZE     optional — "200" or "5k" (default: 5k)
#   RUN_LABEL          optional — short label baked into the run ID
#                                 (default: manual)
#   OUTPUT_BUNDLE_URI  optional — destination prefix for verified bundles.
#                                 Cloud-agnostic; dispatched by URI scheme:
#                                   gs://...   → gcloud storage cp
#                                   file:///   → local cp -r
#                                   /abs/path  → local cp -r (treated as file://)
#                                 Each bundle lands under
#                                   $OUTPUT_BUNDLE_URI/<benchmark-family>/<sha7>/<leaf>/
#                                 If unset, bundles stay on local disk only.
#   HARNESS_COMMIT_SHA   set    — public benchmarks commit the image was
#                                 built from; stamped into output paths.
#
# Behavior: runs `pnpm benchmark run` + `publish-result` + `verify-result`
# once per model type in $MODEL_TYPES, sequentially.

set -euo pipefail

: "${TF_API_KEY:?TF_API_KEY is required}"
: "${MODEL_TYPES:=case-questions,key-facts,laws,regs}"
: "${BENCHMARK_SIZE:=5k}"
: "${RUN_LABEL:=manual}"
: "${OUTPUT_BUNDLE_URI:=}"
: "${HARNESS_COMMIT_SHA:=unknown}"

case "$BENCHMARK_SIZE" in
  200|5k) ;;
  *) echo "BENCHMARK_SIZE must be 200 or 5k (got: $BENCHMARK_SIZE)" >&2; exit 2 ;;
esac

PARALLEL_C=8
SHA7=${HARNESS_COMMIT_SHA:0:7}
DATE=$(date -u +%Y-%m-%d)
RUN_ID="${DATE}-production-${RUN_LABEL}-c${PARALLEL_C}-${BENCHMARK_SIZE}"

# Benchmark family name used at the top of the upload path. All four
# model types belong to the same family; their bundles land as siblings
# under <family>/<sha7>/. Hardcoded for now — when we add a second
# benchmark family (e.g. trustfoundry-legal-judgment) we'll either
# parameterize this or ship a second Dockerfile + entrypoint.
BENCHMARK_FAMILY=trustfoundry-legal-search

# Dispatches an upload of a local directory's contents to a destination URI,
# choosing the appropriate tool based on the URI scheme. Cloud-agnostic
# interface; add more schemes here as needed.
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

# Map each public MODEL_TYPES value to the corresponding suite ID
# (used in result paths) and provider config.
declare -A SUITE_OF=(
  [case-questions]=public-search-case-questions
  [key-facts]=trustfoundry-legal-search-key-facts
  [laws]=trustfoundry-legal-search-laws
  [regs]=trustfoundry-legal-search-regs
)
declare -A PROVIDER_CFG_OF=(
  [case-questions]=configs/providers/trustfoundry-public-search-case-question.json
  [key-facts]=configs/providers/trustfoundry-public-search.json
  [laws]=configs/providers/trustfoundry-public-search.json
  [regs]=configs/providers/trustfoundry-public-search.json
)
# The case-questions benchmark configs use an older "public-search-..." prefix,
# while the other three use "trustfoundry-legal-search-...". Map explicitly.
declare -A BENCH_CFG_PREFIX_OF=(
  [case-questions]=public-search-case-questions
  [key-facts]=trustfoundry-legal-search-key-facts
  [laws]=trustfoundry-legal-search-laws
  [regs]=trustfoundry-legal-search-regs
)

echo "benchmarks entrypoint"
echo "  HARNESS_COMMIT_SHA=${HARNESS_COMMIT_SHA}"
echo "  MODEL_TYPES=${MODEL_TYPES}"
echo "  BENCHMARK_SIZE=${BENCHMARK_SIZE}"
echo "  RUN_LABEL=${RUN_LABEL}"
echo "  OUTPUT_BUNDLE_URI=${OUTPUT_BUNDLE_URI:-(unset — local only)}"
echo "  RUN_ID=${RUN_ID}"

IFS=',' read -ra REQUESTED_TYPES <<< "$MODEL_TYPES"
for type in "${REQUESTED_TYPES[@]}"; do
  type=$(echo "$type" | tr -d '[:space:]')
  if [[ -z "${SUITE_OF[$type]:-}" ]]; then
    echo "Unknown MODEL_TYPES entry: '$type' (valid: ${!SUITE_OF[*]})" >&2
    exit 2
  fi
  suite=${SUITE_OF[$type]}
  prefix=${BENCH_CFG_PREFIX_OF[$type]}
  bench_cfg="configs/benchmarks/${prefix}-${BENCHMARK_SIZE}.json"
  provider_cfg=${PROVIDER_CFG_OF[$type]}
  run_dir="runs/${prefix}-${BENCHMARK_SIZE}"
  bundle_dir="results/${suite}/trustfoundry-public-search/${RUN_ID}"

  echo
  echo "=== ${type} (${suite}) ==="

  pnpm benchmark run \
    --benchmark-config "$bench_cfg" \
    --provider-config "$provider_cfg" \
    --out "$run_dir" \
    --parallel "$PARALLEL_C" \
    --force

  pnpm benchmark publish-result \
    --run "$run_dir" \
    --out "$bundle_dir" \
    --force

  pnpm benchmark verify-result "$bundle_dir"

  if [ -n "$OUTPUT_BUNDLE_URI" ]; then
    # Encode the model type into the leaf dir so all four sibling bundles
    # from one run cluster under <benchmark-family>/<sha7>/ without
    # colliding with each other.
    leaf="${DATE}-production-${RUN_LABEL}-${type}-c${PARALLEL_C}-${BENCHMARK_SIZE}"
    dest="${OUTPUT_BUNDLE_URI%/}/${BENCHMARK_FAMILY}/${SHA7}/${leaf}/"
    echo "uploading ${bundle_dir}/ -> ${dest}"
    upload_bundle "$bundle_dir" "$dest"
  fi
done

echo
echo "benchmarks entrypoint done"
