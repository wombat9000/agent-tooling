# Writing Kotlin

Apply the shared principles in `writing-code` using Kotlin's language features.
Read this reference before writing or reviewing Kotlin code.

- Use named arguments when argument order alone would obscure their meaning.
- Use constructor parameters and `init` checks to enforce intrinsic validity.
  A data class's generated `copy` calls its constructor, so keep those checks on
  the construction path rather than only in a parser or factory.
- For immutable value transitions, a data class with `val` properties and `copy`
  can express the changed state directly. Remember that `val` prevents reference
  reassignment, read-only collection interfaces do not guarantee immutable backing
  data, and `copy` is shallow. Do not treat these features alone as proof that
  earlier states cannot change.
