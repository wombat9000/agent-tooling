# Designing Modules

Organize code so callers need to know less and maintainers can reason locally.
Apply this guidance at the scale of the problem; do not turn a small change into
an architecture project. This reference is language-independent; use it when
choosing or reviewing responsibility boundaries, interfaces, or file organization.

## Judge depth by what callers must understand

A **module** is code with an interface and an implementation: a function, class,
package, or larger subsystem. It is not necessarily a file or a build-system module.

The **interface** includes everything callers must know to use the module correctly:
parameters and results, but also invariants, call ordering, errors, side effects,
configuration, and relevant performance constraints.

A **deep module** provides substantial behavior through a small, clear interface.
A **shallow module** makes callers learn almost as much complexity as it handles.
Depth is not a line-count ratio; adding implementation code does not improve it.

- Design around an operation callers need, not the implementation steps they must
  coordinate. Prefer an interface that completes the operation and owns its rules.
- Keep the interface small without hiding essential costs or failure modes. A
  single method with undocumented ordering requirements is not a simple interface.
- Do not introduce an interface, wrapper, or configurable layer for hypothetical
  future variation. Use concrete code until a real need justifies another concept.

## Hide knowledge, not just code

Identify which decisions belong to the module: representations, parsing rules,
storage details, validation, or coordination. Keep that knowledge behind its
interface rather than requiring each caller to reconstruct it.

- Put invariants with the state or operation that owns them. Avoid requiring
  callers to remember validation or a sequence of preparatory calls.
- Return meaningful results rather than exposing intermediate structures that
  callers must interpret using knowledge of the implementation.
- Let orchestration code express the workflow in meaningful operations. Keep the
  detailed rules for each operation behind its boundary, rather than mixing
  coordination with parsing, validation, or execution mechanics. Extract coherent
  responsibilities, not arbitrary groups of statements.
- Internal helpers are useful when they make the implementation clearer; they
  need not become additional caller-facing concepts.
- A good name does not make a pass-through layer valuable. Imagine removing the
  abstraction: if callers must duplicate meaningful rules, it earns its place;
  if only forwarding disappears, prefer the simpler structure unless the layer
  has another concrete responsibility.

## Keep related knowledge local

Locality means a change and the knowledge needed to make it concentrate in a
coherent place. Look at actual callers, dependencies, tests, and changes before
choosing a boundary.

- Keep details together when understanding or changing one routinely requires
  understanding or changing the others. Avoid scattering one operation across
  many tiny files or layers.
- Separate responsibilities when each has a meaningful purpose and can be
  understood or changed without knowing the other's implementation.
- Some duplication is cheaper than coupling unrelated responsibilities through a
  generic helper. Share knowledge that must stay consistent, not merely similar syntax.
- Preserve useful existing boundaries. Do not split or merge code solely to
  satisfy a preferred shape.

## Distinguish file organization from module design

A module can span several files while retaining one interface. A file can contain
several closely related declarations without being poorly organized.

Group code around a coherent responsibility. Separate responsibilities that require
different knowledge or change for different reasons, even when the combined file
is short. Keep closely collaborating implementation details together when splitting
would scatter understanding. Choose file boundaries by cohesion and information
hiding—not line count or one-class-per-file rules.

- Moving code into another file does not by itself create a better abstraction.
- Avoid widening visibility merely to make a proposed file layout work. Weigh
  the navigation benefit against exposing implementation details.

## Examples of the tradeoff

**Too fragmented:** a caller loads a record, checks eligibility, calculates a fee,
updates a balance, and writes an audit entry by coordinating five thin wrappers.
If these steps jointly define one operation, a `settlePayment` module can own their
ordering and failure rules. Its implementation may still use focused private parts;
callers should not have to implement settlement themselves.

**Too mixed:** a report exporter contains both file-format encoding and delivery
retry policy. If either can change without understanding the other, separate them
behind focused internal operations. Keep a simple `exportReport` entry point if
callers need the complete operation; do not expose every intermediate step.

Neither example mandates a class hierarchy, dependency injection framework, or a
particular file count. The benefit must be less knowledge for callers or better
locality for maintainers, not just more names.

## Keep boundaries useful

If restructuring does not reduce cognitive burden, keep the current structure.

Prefer tests through the module's interface so internal reorganization does not
require rewriting assertions. Do not expose private helpers just to test them.

## Sources

Adapted from the deep-module concept in John Ousterhout's *A Philosophy of Software
Design* and Matt Pocock's
[codebase-design](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md)
and [improve-codebase-architecture](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md)
skills. These are background sources, not required skills or runtime dependencies.
