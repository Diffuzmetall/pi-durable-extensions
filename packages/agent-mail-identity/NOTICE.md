# Notices and license status

This experimental package is the first-party Agent Mail identity and watcher extension from this collection,
promoted from the accepted Pi Durable candidate snapshot in the Pi Pocket sandbox. It is licensed MIT by the
copyright holder; the canonical text is in [`LICENSE`](./LICENSE). The module is first-party code written for
this collection: it contains no third-party source, no vendored file and no copied Pocket code.

The candidate's own source candidates remain frozen by the retained SHA-256 manifests in
`test/evidence/` (AM1 `candidate.sha256`, AM2 `am2-candidate.sha256`, AM3 `am3-candidate.sha256`); the
surrounding sandbox run logs, fixture runtime scratch and delivery reports stay outside this public tree.

## Interoperability, not a grant

The package reads and binds an existing Agent Mail identity through a host-supplied command line transport,
and it can be embedded in Pi Durable and, through its separate entry point, in an optional Pi Pocket host.
Nothing here grants rights to Pi Pocket, Pi Durable, Pi AI, Chord, the Agent Mail service, or any other
external product or service. Referencing those names describes interoperability only.

## Runtime dependencies

The package declares its runtime peers in `package.json`:

- `@earendil-works/pi-durable@1.1.0`
- `@earendil-works/pi-ai@1.1.0`

`@earendil-works/chord@1.1.0` is a test-only dev dependency. Their license files remain those packages'
responsibility; this package does not copy or modify them. The `am` executable the watcher is pointed at is
a host-supplied external tool: it is not bundled, installed, or started by this package.

## Candidate status

Candidate only. No publication, stable, registry-distribution, production-activation, live Agent Mail,
Pocket wake, or performance claim is made. The `test:live:*` and `bench` scripts are deliberately
fail-closed: each exits 2 with the reason its lane cannot run instead of printing a fabricated receipt.
