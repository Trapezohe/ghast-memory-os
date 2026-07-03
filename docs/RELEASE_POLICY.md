# gmOS Release Policy

gmOS is pre-1.0. The project treats public contracts conservatively, but the
alpha line can still change while 0.2 criteria are being completed.

## Cadence

Alpha releases are cut when the local release gate, release evidence bundle, and
documentation checks pass. There is no fixed calendar promise during alpha.

The 0.2 line requires:

- public CI matrix health on macOS and Linux for supported Node lines;
- current release evidence bundle;
- benchmark reproduction bundles for any public benchmark number;
- API stability table reviewed for all public exports;
- release-signal scale profile recorded for `10000` memories and documented
  target for `100000` memories on release machines.

## Semver Before 1.0

Patch versions in the alpha line may add APIs, tighten validation, or change
experimental behavior. Stable-candidate APIs avoid unnecessary breakage, but
the compatibility promise becomes strict only after 1.0.

Experimental APIs can change or be removed between alpha versions when the old
shape would create maintenance debt or a misleading contract.

## Deprecation

Stable-candidate APIs get one minor line of dual support before removal when a
replacement exists. The deprecated path must warn at runtime or in generated
types where practical, and `docs/MIGRATION.md` must include the upgrade path.

Experimental APIs may skip dual support, but release notes should call out the
change and explain the replacement when one exists.

## Upgrade Guarantees

SQLite schema migrations are automatic and idempotent. Re-running a migration
must be safe.

Profile backups and portable bundles remain readable forever by the current
tooling. If a future format is introduced, current tooling must keep an import
path for older bundles.

Safe backups, encrypted bundles, and restore flows must not require network
access or hosted custody.
