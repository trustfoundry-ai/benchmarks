// TypeScript declarations for the `./core` sub-path barrel.
//
// The `./core` sub-path is a convenience for consumers who want the
// full runtime toolkit in one import. Symbols that are ALSO exported
// from the root barrel are the stable public API; symbols that appear
// here but NOT in the root barrel are internal and may change without
// notice.
//
// For discoverability and type-checking we mirror the public surface
// here. Internal helpers are declared as `unknown` — if you need types
// for one of them, promote it to the root barrel and add a signature to
// `../index.d.mts` instead of tightening it here.

export * from '../index.d.mts';
