# Mars Rover — benchmark v3, phase one

This is a fixed coding-interview task. Implement a Kotlin library that reads a rover
setup and independent command sequences from a text file and returns their final
positions as text. No CLI, network, file writes, UI, concurrency, logging, or third-party
dependencies are needed.

## Public API

Create this entry point in package `rover`, under `src/main/kotlin/rover/`.
Do not change its name, parameter type, or return type. The returned string is
the complete output defined below; do not print it or write an output file.
No domain types or internal interfaces are prescribed. Choose the internal model
freely. No source or tests are provided: write both as part of the evaluation.

```kotlin
package rover

import java.nio.file.Path

object MarsRover {
    fun execute(inputFile: Path): String
}
```

## Input file

- Read the file as UTF-8. Accept LF and CRLF line endings, with or without a final
  line ending. A final line ending terminates the last line; it does not introduce
  an extra command-sequence line.
- The first line contains exactly five fields, in this order:
  `width height x y direction`. Separate fields with one or more ASCII spaces or
  tabs; leading and trailing spaces or tabs on this line are allowed.
- The first four fields are base-10 integers in the Kotlin `Int` range. An optional
  leading `+` or `-` is allowed; digits must be ASCII `0` through `9`.
- The direction is exactly one of `NORTH`, `EAST`, `SOUTH`, or `WEST`.
- Each subsequent line contains a sequence of zero or more commands using only
  `L`, `R`, and `M`, with no separators. Each line represents a fresh rover run
  using the grid dimensions, starting coordinates, and heading from the header.
  A run never inherits the position or heading reached by a previous line.
- Do not trim command-sequence lines or ignore blank lines. A blank line is an
  empty sequence and produces the starting position. Whitespace within a sequence,
  comments, and obstacle declarations are not supported.
- A header-only file is valid and returns an empty string: it defines no runs. An
  empty file is invalid. For example, `header\n` defines no runs, whereas
  `header\n\n` defines one empty run.

## World and commands

- Width and height are positive `Int` values. Valid coordinates are `0 until width`
  and `0 until height`; `(0, 0)` is the southwest corner. North increases `y`, east
  increases `x`.
- `L` turns left 90°, `R` turns right 90°, and `M` moves forward one cell. Only
  uppercase ASCII `L`, `R`, and `M` are valid.
- The grid wraps at every edge, independently in both dimensions. There is no
  maximum size below `Int.MAX_VALUE`; arithmetic must not overflow at valid boundaries.
- Process each sequence from left to right, starting from the header's position
  and heading. Return one final position and heading per sequence, in file order,
  preserving duplicate results. There are no obstacles or blocked moves. A 1×1
  grid is valid; a move wraps back to the same cell.

## Output text

Return one line per command sequence, in file order, preserving duplicate results.
Each line contains the final coordinates and heading in this format:

```text
x y direction
```

Separate fields with exactly one ASCII space and lines with exactly one LF
(`\n`), regardless of the input line endings. Do not include leading/trailing
spaces, blank lines, or a final line ending. Format coordinates as ordinary
base-10 integers without a leading `+` or leading zeros, except for `0` itself.
Headings are exactly `NORTH`, `EAST`, `SOUTH`, or `WEST`.

A header-only file returns `""`. An empty command sequence produces one line
containing the starting coordinates and heading; it does not produce a blank
output line.

## Invalid input

Throw `IllegalArgumentException` for an empty file, malformed header, integer
outside the `Int` range, nonpositive dimension, out-of-bounds start, invalid
direction, or invalid command line anywhere in the file. No particular exception
message or validation order is required. Any invalid sequence makes the entire
call fail; do not skip invalid lines or return partial results. File-access
failures, such as a missing or unreadable file, must propagate as
`java.io.IOException` rather than being treated as malformed rover input.

Do not modify the input file. Neither runs within a file nor independent calls
may share mutable rover state.

## Examples

This file defines three independent runs:

```text
5 4 4 1 EAST
MMRMLM
MRM
MMRMLM
```

It returns this text, with no final line ending:

```text
2 0 EAST
0 0 SOUTH
2 0 EAST
```

A file containing only `5 4 4 1 EAST` returns `""`. An empty sequence
returns `"4 1 EAST"`. A sequence containing `m`, `M R`, or
` MM` is invalid.

## Tests & Verification

Write tests under `src/test/kotlin/rover/` using the configured Kotlin/JUnit 5 stack.
Cover this contract through its public API, including boundary cases and invalid
inputs. Tests should create their own temporary input files and clean them up.
Passing your own tests is necessary but not independent proof of correctness:
reviewers assess both implementation and test quality against this specification.
There is no mandated class hierarchy or algorithm.

Verify with `./gradlew test`.
