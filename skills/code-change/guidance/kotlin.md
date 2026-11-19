# Kotlin

Applies the shared guidelines with Kotlin's language features.

- **K1 (Default)** Use named arguments when argument order alone would obscure
  their meaning, for example adjacent parameters of the same type.
- **K2 (Rule)** Enforce intrinsic validity (`D2`) with constructor parameters and
  `init` checks. A data class's generated `copy` calls its constructor, so checks
  in a parser or factory alone can be bypassed.
- **K3 (Rule)** For immutable transitions (`D1`), a data class with `val`
  properties and `copy` expresses changed state directly. Do not treat `val`,
  read-only collection interfaces or `copy` as proof that earlier states cannot
  change: `val` only prevents reassignment, a read-only interface can be backed by
  a mutable collection, and `copy` is shallow. Where earlier state must not
  change, use truly immutable collections or defensive copies.
