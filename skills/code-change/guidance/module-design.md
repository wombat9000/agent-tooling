# Module design

Organize code so callers need to know less and maintainers can reason locally.
Apply this at the scale of the problem; a small change is not an architecture
project. Language-independent.

Contents: concepts · depth · hiding knowledge · locality · files · examples ·
reviewing design.

## Concepts

- A **module** is anything with an interface and an implementation: a function,
  class, package or subsystem. It need not be a file or build module.
- Its **interface** is everything callers must know to use it correctly:
  parameters and results, but also invariants, call ordering, errors, side
  effects, configuration and relevant performance constraints.
- A **deep module** provides substantial behavior through a small, clear
  interface. A **shallow module** makes callers learn almost as much as it
  handles. Depth is not a line-count ratio.

## Depth

- **M1 (Rule)** Design around an operation callers need, not the implementation
  steps they must coordinate. The interface completes the operation and owns its
  rules.
- **M2 (Rule)** Keep the interface small without hiding essential costs or failure
  modes. A single method with undocumented ordering requirements is not a simple
  interface.

See also `C7`: no layers for hypothetical future variation.

## Hiding knowledge

- **M3 (Rule)** Keep each decision (representation, parsing, storage, validation,
  coordination) behind the interface of the module that owns it. Put invariants
  with the state or operation that owns them; callers should not have to repeat
  validation or remember a sequence of preparatory calls.
- **M4 (Default)** Return meaningful results rather than intermediate structures
  that callers must interpret using knowledge of the implementation.
- **M5 (Rule)** Write workflow and entry-point code as a sequence of meaningful
  operations that a reader can follow without deciphering mechanics; delegate
  low-level boundary and domain mechanics to focused units rather than inlining
  them. Keep protocol concerns (parsing, encoding, transport types, and protocol
  status codes or exceptions) at the entry-point boundary, storage mechanics
  (query construction, row mapping) in persistence code, and business rules and
  workflow coordination in application or domain logic between them—do not wire
  transport handlers directly into a repository or store that absorbs business
  rules or throws transport errors.
- **M6 (Rule)** Apply the deletion test to a suspected pass-through layer: imagine
  removing it. If callers, transport handlers, or persistence adapters would
  have to absorb or duplicate meaningful business rules, workflow coordination,
  or domain-to-protocol translation, it earns its place (and needs no interface
  when there is one implementation, per `M8` and `C7`). If only forwarding
  disappears, remove it, unless it has another concrete responsibility. A good
  name does not make a pass-through valuable.

Internal helpers that clarify an implementation are fine and need not become
caller-facing concepts.

## Locality

Locality means a change, and the knowledge needed to make it, concentrates in one
coherent place. Base boundaries on actual callers, dependencies, tests and change
history.

- **M7 (Rule)** Keep together code that is routinely understood or changed
  together. Do not scatter one operation across many tiny files or layers.
- **M8 (Rule)** Separate responsibilities that can be understood or changed
  independently, judged by the knowledge, dependencies and reasons to change they
  involve, even when the combined code is short. One caller and one
  implementation can justify a boundary; it does not need an interface.
- **M9 (Default)** Prefer some duplication over coupling unrelated
  responsibilities through a generic helper. Share knowledge that must stay
  consistent, not merely similar syntax.
- **M10 (Rule)** Preserve useful existing boundaries. Do not split or merge code
  only to reach a preferred shape.

## Files

- **M11 (Rule)** Put one top-level type or focused responsibility in each file,
  named after it, so readers and reviewers can navigate by filename rather than
  scrolling through one long file. Exceptions are narrow and cohesive: a sealed
  or discriminated-union type hierarchy with its subtypes, or a small private
  helper/value type used exclusively as an internal detail of that one file. Do
  not group multiple distinct domain types or separate responsibilities (such as
  entry point, parsing or formatting, and domain models) into one file just
  because the combined code is short or internal to the package (see `M12`).
- **M12 (Rule)** Do not widen visibility into the public API only to make a file
  layout or a test work. Keep helpers shared across separated files (`M8`, `M11`)
  internal to the module or package using the language's boundary mechanism—such
  as Kotlin `internal`, package-private visibility, or file-level `export` in
  TypeScript/ESM without re-exporting from the package entry point (`index.ts`
  or `package.json` `exports`); exposing internal types or helpers as part of
  the public API is not.

## Examples

**Too fragmented:** a caller loads a record, checks eligibility, calculates a fee,
updates a balance and writes an audit entry by coordinating five thin wrappers. If
these steps jointly define one operation, a `settlePayment` module can own their
ordering and failure rules (`M1`, `M3`). Its implementation may still use focused
private parts.

**Too mixed:** a report exporter contains both file-format encoding and delivery
retry policy. If either can change without understanding the other, separate them
behind focused internal operations (`M8`). Keep a simple `exportReport` entry
point if callers need the complete operation.

Neither example requires a class hierarchy, a dependency-injection framework or a
particular number of files. The benefit must be less knowledge for callers or
better locality for maintainers, not more names.

## Reviewing design

Investigate before judging: who calls the code, what they must know, and what is
hard to read or change. Look inside workflow code as well as at its callers. A
long method or multiple cooperating files are signals to investigate, not
findings on their own.

Questions that often apply:

- Do construction and transition paths preserve the domain's invariants, or must
  callers reconstruct rules and remember preparatory steps?
- Does understanding one operation require navigating unrelated responsibilities
  or many thin layers? What knowledge crosses those boundaries?
- For a change that the requirements or history make likely, what would have to
  change together? Would a different boundary concentrate that knowledge without
  exposing more detail?

**Three-part test.** A design finding is *Should fix* only when you can state all
three:

1. A concrete change scenario taken from the requirements, the change history or
   the actual callers, not an invented future requirement.
2. The code that this scenario forces to change together, or the knowledge a
   caller must reconstruct.
3. A smaller alternative and its cost in new concepts, navigation, coupling or
   visibility.

Otherwise report it as *Optional*, or not at all. Keeping a cohesive file, or
merging fragmented code, are valid recommendations.

## Sources

Adapted from John Ousterhout's *A Philosophy of Software Design* and Matt Pocock's
[codebase-design](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md)
and [improve-codebase-architecture](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md)
skills. Background only; not runtime dependencies.
