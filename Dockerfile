# Reproducible container for the TrustFoundry benchmarks harness.
#
# Build:
#   docker build -t ttf-benchmarks .
#
# Run (local, no cloud upload):
#   docker run --rm -e TF_API_KEY=$TF_API_KEY \
#     -e BENCHMARK_SIZE=200 -e MODEL_TYPES=case-questions ttf-benchmarks
#
# Run (with upload of each verified bundle — cloud-agnostic, dispatched by
# URI scheme; gs:// uses the bundled gcloud SDK, file:///abs/path uses cp):
#   docker run --rm -e TF_API_KEY=$TF_API_KEY \
#     -e OUTPUT_BUNDLE_URI=gs://your-bucket/some/prefix \
#     -v $HOME/.config/gcloud:/root/.config/gcloud \
#     ttf-benchmarks
#
# The HARNESS_COMMIT_SHA build arg is set by CI to the source commit so the
# entrypoint can stamp it into output paths. Manual builds default it to
# "unknown".

ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${NODE_IMAGE}

ARG HARNESS_COMMIT_SHA=unknown
ENV HARNESS_COMMIT_SHA=${HARNESS_COMMIT_SHA}

# gcloud SDK is bundled so the entrypoint's gs:// uploader path works out
# of the box. The upload step only runs when OUTPUT_BUNDLE_URI is set, so
# a local-only run does not require GCP credentials to be mounted. To
# support other clouds (s3://, etc.), add the corresponding CLI here and
# extend the upload_bundle dispatch in entrypoint.sh.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates python3 gnupg apt-transport-https \
    && curl -sS https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] http://packages.cloud.google.com/apt cloud-sdk main" \
        > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app
COPY . ./

RUN pnpm install --frozen-lockfile

RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
