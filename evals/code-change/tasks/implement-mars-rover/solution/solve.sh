#!/usr/bin/env bash
# Reference solution for Harbor's oracle check (benchmark v3, phase one).
set -euo pipefail

mkdir -p /workspace/src/main/kotlin/rover /workspace/src/test/kotlin/rover

cat > /workspace/src/main/kotlin/rover/Position.kt <<'EOF'
package rover

/** A coordinate on a wrapping grid with (0, 0) at the southwest corner. */
internal data class Position(val x: Int, val y: Int)
EOF

cat > /workspace/src/main/kotlin/rover/Direction.kt <<'EOF'
package rover

/** Cardinal heading of a rover. */
internal enum class Direction {
    NORTH,
    EAST,
    SOUTH,
    WEST;

    fun turnLeft(): Direction = when (this) {
        NORTH -> WEST
        WEST -> SOUTH
        SOUTH -> EAST
        EAST -> NORTH
    }

    fun turnRight(): Direction = when (this) {
        NORTH -> EAST
        EAST -> SOUTH
        SOUTH -> WEST
        WEST -> NORTH
    }
}
EOF

cat > /workspace/src/main/kotlin/rover/Command.kt <<'EOF'
package rover

/** A single rover movement or rotation command. */
internal enum class Command {
    TURN_LEFT,
    TURN_RIGHT,
    MOVE,
}
EOF

cat > /workspace/src/main/kotlin/rover/Grid.kt <<'EOF'
package rover

/**
 * Rectangular wrapping grid of positive dimensions up to Int.MAX_VALUE.
 * Coordinates satisfy 0 until width and 0 until height.
 */
internal class Grid(val width: Int, val height: Int) {
    init {
        require(width > 0) { "Grid width must be positive: $width" }
        require(height > 0) { "Grid height must be positive: $height" }
    }

    fun contains(position: Position): Boolean =
        position.x in 0 until width && position.y in 0 until height

    /** Moves one cell in [direction], wrapping at every edge without integer overflow. */
    fun step(position: Position, direction: Direction): Position {
        require(contains(position)) { "Position $position is outside ${width}x$height grid" }
        return when (direction) {
            Direction.NORTH -> position.copy(y = if (position.y == height - 1) 0 else position.y + 1)
            Direction.EAST -> position.copy(x = if (position.x == width - 1) 0 else position.x + 1)
            Direction.SOUTH -> position.copy(y = if (position.y == 0) height - 1 else position.y - 1)
            Direction.WEST -> position.copy(x = if (position.x == 0) width - 1 else position.x - 1)
        }
    }
}
EOF

cat > /workspace/src/main/kotlin/rover/Rover.kt <<'EOF'
package rover

/**
 * Immutable rover state bound to a valid position on its [grid].
 * Executing commands returns a new Rover without mutating the receiver.
 */
internal data class Rover(
    val grid: Grid,
    val position: Position,
    val direction: Direction,
) {
    init {
        require(grid.contains(position)) { "Rover position $position is outside grid" }
    }

    fun execute(commands: List<Command>): Rover =
        commands.fold(this) { current, command -> current.apply(command) }

    private fun apply(command: Command): Rover = when (command) {
        Command.TURN_LEFT -> copy(direction = direction.turnLeft())
        Command.TURN_RIGHT -> copy(direction = direction.turnRight())
        Command.MOVE -> copy(position = grid.step(position, direction))
    }
}
EOF

cat > /workspace/src/main/kotlin/rover/InputParser.kt <<'EOF'
package rover

/** Parsed header state and independent command sequences from a mission input file. */
internal data class RoverMission(
    val initialRover: Rover,
    val sequences: List<List<Command>>,
)

/**
 * Parses the UTF-8 phase-one text format into validated domain values.
 * Accepts LF and CRLF line endings; a trailing line ending terminates the last line.
 */
internal object InputParser {
    fun parse(content: String): RoverMission {
        if (content.isEmpty()) {
            throw IllegalArgumentException("Input file must not be empty")
        }
        val lines = splitLines(content)
        val initialRover = parseHeader(lines.first())
        val sequences = lines.drop(1).map(::parseCommandLine)
        return RoverMission(initialRover, sequences)
    }

    private fun splitLines(content: String): List<String> {
        val lines = mutableListOf<String>()
        var lineStart = 0
        var index = 0
        while (index < content.length) {
            when (content[index]) {
                '\n' -> {
                    lines.add(content.substring(lineStart, index))
                    index += 1
                    lineStart = index
                }
                '\r' -> {
                    if (index + 1 < content.length && content[index + 1] == '\n') {
                        lines.add(content.substring(lineStart, index))
                        index += 2
                        lineStart = index
                    } else {
                        throw IllegalArgumentException("Unsupported bare CR line ending")
                    }
                }
                else -> index += 1
            }
        }
        if (lineStart < content.length) {
            lines.add(content.substring(lineStart))
        }
        return lines
    }

    private fun parseHeader(line: String): Rover {
        val fields = splitAsciiSpacesOrTabs(line)
        require(fields.size == 5) { "Header must contain exactly 5 fields, got ${fields.size}" }
        val width = parseAsciiInt(fields[0])
        val height = parseAsciiInt(fields[1])
        val x = parseAsciiInt(fields[2])
        val y = parseAsciiInt(fields[3])
        val direction = parseDirection(fields[4])
        val grid = Grid(width = width, height = height)
        return Rover(grid = grid, position = Position(x = x, y = y), direction = direction)
    }

    private fun splitAsciiSpacesOrTabs(line: String): List<String> {
        val fields = mutableListOf<String>()
        var index = 0
        while (index < line.length) {
            while (index < line.length && isAsciiSpaceOrTab(line[index])) {
                index += 1
            }
            if (index >= line.length) break
            val start = index
            while (index < line.length && !isAsciiSpaceOrTab(line[index])) {
                index += 1
            }
            fields.add(line.substring(start, index))
        }
        return fields
    }

    private fun isAsciiSpaceOrTab(ch: Char): Boolean = ch == ' ' || ch == '\t'

    private fun parseAsciiInt(token: String): Int {
        require(isAsciiSignedIntToken(token)) { "Invalid integer token: '$token'" }
        return token.toIntOrNull()
            ?: throw IllegalArgumentException("Integer out of Int range: '$token'")
    }

    private fun isAsciiSignedIntToken(token: String): Boolean {
        if (token.isEmpty()) return false
        val firstDigitIndex = if (token[0] == '+' || token[0] == '-') 1 else 0
        if (firstDigitIndex == token.length) return false
        for (i in firstDigitIndex until token.length) {
            if (token[i] !in '0'..'9') return false
        }
        return true
    }

    private fun parseDirection(token: String): Direction = when (token) {
        "NORTH" -> Direction.NORTH
        "EAST" -> Direction.EAST
        "SOUTH" -> Direction.SOUTH
        "WEST" -> Direction.WEST
        else -> throw IllegalArgumentException("Invalid direction: '$token'")
    }

    private fun parseCommandLine(line: String): List<Command> = line.map { token ->
        when (token) {
            'L' -> Command.TURN_LEFT
            'R' -> Command.TURN_RIGHT
            'M' -> Command.MOVE
            else -> throw IllegalArgumentException("Invalid command character: '$token'")
        }
    }
}
EOF

cat > /workspace/src/main/kotlin/rover/OutputFormatter.kt <<'EOF'
package rover

/** Formats final rover states as LF-separated `x y direction` lines with no trailing newline. */
internal object OutputFormatter {
    fun format(rovers: List<Rover>): String =
        rovers.joinToString(separator = "\n") { rover ->
            "${rover.position.x} ${rover.position.y} ${formatDirection(rover.direction)}"
        }

    private fun formatDirection(direction: Direction): String = when (direction) {
        Direction.NORTH -> "NORTH"
        Direction.EAST -> "EAST"
        Direction.SOUTH -> "SOUTH"
        Direction.WEST -> "WEST"
    }
}
EOF

cat > /workspace/src/main/kotlin/rover/MarsRover.kt <<'EOF'
package rover

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/** Public entry point for executing Mars Rover command files. */
object MarsRover {
    /**
     * Reads a UTF-8 rover setup and independent command sequences from [inputFile]
     * and returns one `x y direction` line per sequence joined by LF.
     * Throws IllegalArgumentException on malformed input and propagates IOException on file errors.
     */
    fun execute(inputFile: Path): String {
        val content = Files.readString(inputFile, StandardCharsets.UTF_8)
        val mission = InputParser.parse(content)
        val finalStates = mission.sequences.map { commands ->
            mission.initialRover.execute(commands)
        }
        return OutputFormatter.format(finalStates)
    }
}
EOF

cat > /workspace/src/test/kotlin/rover/MarsRoverTest.kt <<'EOF'
package rover

import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class MarsRoverTest {

    private fun runText(content: String): String {
        val dir = Files.createTempDirectory("mars-rover-test-")
        try {
            val file = dir.resolve("mission.txt")
            Files.writeString(file, content, StandardCharsets.UTF_8)
            return MarsRover.execute(file)
        } finally {
            Files.walk(dir).sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }

    @Test
    fun executesIndependentRunsFromExample() {
        val result = runText("5 4 4 1 EAST\nMMRMLM\nMRM\nMMRMLM")
        assertEquals("2 0 EAST\n0 0 SOUTH\n2 0 EAST", result)
    }

    @Test
    fun handlesHeaderOnlyAndEmptySequencesWithCrlf() {
        assertEquals("", runText("5 4 4 1 EAST"))
        assertEquals("", runText("5 4 4 1 EAST\r\n"))
        assertEquals("4 1 EAST", runText("5 4 4 1 EAST\r\n\r\n"))
    }

    @Test
    fun wrapsAtIntMaxValueWithoutOverflow() {
        val max = Int.MAX_VALUE
        val last = max - 1
        assertEquals("0 $last EAST", runText("$max $max $last $last EAST\nM"))
        assertEquals("$last 0 WEST", runText("$max $max 0 0 WEST\nM"))
    }

    @Test
    fun rejectsInvalidInputsAndPropagatesIoException() {
        assertFailsWith<IllegalArgumentException> { runText("") }
        assertFailsWith<IllegalArgumentException> { runText("5 4 4 1 EAST\nM R") }
        assertFailsWith<IllegalArgumentException> { runText("0 4 0 0 NORTH") }
        val dir = Files.createTempDirectory("mars-rover-missing-")
        try {
            assertFailsWith<IOException> { MarsRover.execute(dir.resolve("missing.txt")) }
        } finally {
            Files.deleteIfExists(dir)
        }
    }
}
EOF
