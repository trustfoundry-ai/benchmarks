// Operational defaults for the shipped CLI, and the precedence logic that
// decides what `run` actually passes to `executeRun`. The framework core
// has no hardcoded default adapter; this is the layer that names the
// shipped `trustfoundry-legal-search` suite as an out-of-the-box
// convenience. Consumers who wire their own adapter register it and pass
// explicit --benchmark-config / --provider-config / --scorer-config paths,
// or a --target that resolves them through the suite registry.
//
// This lives in its own module, outside any `package.json` `exports`
// entry, on purpose: it is CLI flag plumbing (it operates on
// `parseArgs`-shaped options), not domain logic, so it doesn't belong
// under `./core/*` — and unlike `./cli`, nothing publishes this path, so
// it stays free to change shape without being a public API commitment.

export const DEFAULT_BENCHMARK_CONFIG = 'configs/benchmarks/trustfoundry-legal-search/case-questions-200.json';
export const DEFAULT_PROVIDER_CONFIG = 'configs/providers/trustfoundry-legal-search.json';
export const DEFAULT_SCORER_CONFIG = 'configs/scorers/trustfoundry-legal-search.json';
export const DEFAULT_OUT_DIR = 'runs/trustfoundry-legal-search-case-questions-200';

// A CLI flag with no value following it (or a value that is itself
// another `--flag`) parses to boolean `true`, not a path. Only a non-empty
// string counts as "the flag was actually given a value" — this is what
// lets a bare `--out` or `--benchmark-config` fall through to the next
// precedence tier instead of being treated as an explicit override.
function stringOption(value) {
  return typeof value === 'string' && value.length ? value : undefined;
}

// Pure precedence resolution for `run`'s config triple and out dir, kept
// separate from `runCommand` so it can be unit-tested without executeRun
// (no network, no benchmark execution): given the raw CLI `options` and
// the already-resolved `--target` (or `null` when none was given), it
// decides what wins. `stringOption(...)` is what tells "flag given" apart
// from "flag absent" for every field here, including `out` — an explicit
// flag is always a non-empty string, so it always outranks a value the
// registry resolved from `--target`, which in turn outranks the
// operational default. Passing no target and no flags reproduces the
// DEFAULT_* / DEFAULT_OUT_DIR behavior unchanged.
export function resolveRunConfig(options, resolved) {
  return {
    outDir: stringOption(options.out) ?? (resolved ? `runs/${resolved.bundle}` : DEFAULT_OUT_DIR),
    benchmarkConfigPath:
      stringOption(options['benchmark-config']) ?? resolved?.benchmarkConfig ?? DEFAULT_BENCHMARK_CONFIG,
    providerConfigPath:
      stringOption(options['provider-config']) ?? resolved?.providerConfig ?? DEFAULT_PROVIDER_CONFIG,
    scorerConfigPath:
      stringOption(options['scorer-config']) ?? resolved?.scorerConfig ?? DEFAULT_SCORER_CONFIG
  };
}
