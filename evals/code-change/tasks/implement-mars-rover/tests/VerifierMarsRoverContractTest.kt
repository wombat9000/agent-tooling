package rover

import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class VerifierMarsRoverContractTest {

    private fun withInputFile(content: String, block: (Path) -> Unit) {
        val dir = Files.createTempDirectory("mars-rover-verifier-")
        try {
            val file = dir.resolve("input.txt")
            Files.writeString(file, content, StandardCharsets.UTF_8)
            block(file)
            assertEquals(content, Files.readString(file, StandardCharsets.UTF_8), "Input file must not be modified")
        } finally {
            Files.walk(dir).sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }

    private fun runInput(content: String): String {
        var result = ""
        withInputFile(content) { file ->
            result = MarsRover.execute(file)
        }
        return result
    }

    @Test
    fun specExampleProducesExpectedIndependentRunsAndPreservesDuplicates() {
        val input = "5 4 4 1 EAST\nMMRMLM\nMRM\nMMRMLM"
        val expected = "2 0 EAST\n0 0 SOUTH\n2 0 EAST"
        assertEquals(expected, runInput(input))
    }

    @Test
    fun headerOnlyWithAndWithoutFinalLineEndingsReturnsEmptyString() {
        assertEquals("", runInput("5 4 4 1 EAST"))
        assertEquals("", runInput("5 4 4 1 EAST\n"))
        assertEquals("", runInput("5 4 4 1 EAST\r\n"))
    }

    @Test
    fun emptySequenceLinesProduceStartingPosition() {
        assertEquals("4 1 EAST", runInput("5 4 4 1 EAST\n\n"))
        assertEquals("4 1 EAST", runInput("5 4 4 1 EAST\r\n\r\n"))
        assertEquals("4 1 EAST\n4 1 EAST", runInput("5 4 4 1 EAST\n\n\n"))
        assertEquals("4 1 EAST\n0 1 EAST\n4 1 EAST", runInput("5 4 4 1 EAST\n\nM\n\n"))
    }

    @Test
    fun acceptsCrlfAndMixedLineEndingsAndEmitsLfOnly() {
        val input = "5 4 4 1 EAST\r\nMMRMLM\r\nMRM\nMMRMLM\r\n"
        val expected = "2 0 EAST\n0 0 SOUTH\n2 0 EAST"
        assertEquals(expected, runInput(input))
    }

    @Test
    fun acceptsHeaderTabsLeadingTrailingSpacesSignsAndLeadingZeros() {
        val input = " \t +005\t  04 \t +00\t -0 \tNORTH \t\nM"
        assertEquals("0 1 NORTH", runInput(input))
    }

    @Test
    fun turnsFullCircleInBothDirections() {
        val input = "3 3 1 1 NORTH\nL\nLL\nLLL\nLLLL\nR\nRR\nRRR\nRRRR"
        val expected = listOf(
            "1 1 WEST",
            "1 1 SOUTH",
            "1 1 EAST",
            "1 1 NORTH",
            "1 1 EAST",
            "1 1 SOUTH",
            "1 1 WEST",
            "1 1 NORTH",
        ).joinToString("\n")
        assertEquals(expected, runInput(input))
    }

    @Test
    fun wrapsAcrossAllFourEdgesAndOnUnitGrid() {
        assertEquals("1 0 NORTH", runInput("3 2 1 1 NORTH\nM"))
        assertEquals("0 1 EAST", runInput("3 2 2 1 EAST\nM"))
        assertEquals("1 1 SOUTH", runInput("3 2 1 0 SOUTH\nM"))
        assertEquals("2 1 WEST", runInput("3 2 0 1 WEST\nM"))
        assertEquals("0 0 NORTH\n0 0 EAST", runInput("1 1 0 0 NORTH\nMMM\nRMM"))
    }

    @Test
    fun handlesIntMaxValueDimensionsWithoutOverflow() {
        val max = Int.MAX_VALUE
        val last = max - 1
        assertEquals("0 $last EAST", runInput("$max $max $last $last EAST\nM"))
        assertEquals("$last 0 NORTH", runInput("$max $max $last $last NORTH\nM"))
        assertEquals("$last 0 WEST", runInput("$max $max 0 0 WEST\nM"))
        assertEquals("0 $last SOUTH", runInput("$max $max 0 0 SOUTH\nM"))
    }

    @Test
    fun rejectsEmptyAndMalformedHeaders() {
        val invalidInputs = listOf(
            "",
            "\n",
            "\r\n",
            "   \t  ",
            "5 4 1 1",
            "5 4 1 1 NORTH EXTRA",
            "0 4 0 0 NORTH",
            "5 0 0 0 NORTH",
            "-5 4 0 0 NORTH",
            "5 -4 0 0 NORTH",
            "5 4 -1 0 NORTH",
            "5 4 0 -1 NORTH",
            "5 4 5 0 NORTH",
            "5 4 0 4 NORTH",
            "2147483648 4 0 0 NORTH",
            "5 2147483648 0 0 NORTH",
            "5 4 -2147483649 0 NORTH",
            "+ 4 0 0 NORTH",
            "5 - 0 0 NORTH",
            "٥ 4 0 0 NORTH",
            "5\u00A04 0 0 NORTH",
            "5 4 0 0 N",
            "5 4 0 0 north",
            "5 4 0 0 NORTHEAST",
        )
        for (input in invalidInputs) {
            assertFailsWith<IllegalArgumentException>("Expected failure for header: ${input.replace("\n", "\\n")}") {
                runInput(input)
            }
        }
    }

    @Test
    fun rejectsInvalidCommandLinesAnywhereInFile() {
        val invalidInputs = listOf(
            "5 4 0 0 NORTH\nm",
            "5 4 0 0 NORTH\nM R",
            "5 4 0 0 NORTH\n MM",
            "5 4 0 0 NORTH\nMM ",
            "5 4 0 0 NORTH\n\tM",
            "5 4 0 0 NORTH\nF",
            "5 4 0 0 NORTH\nB",
            "5 4 0 0 NORTH\nMMM\nLMR\nBAD",
            "5 4 0 0 NORTH\nMMM\rR",
        )
        for (input in invalidInputs) {
            assertFailsWith<IllegalArgumentException>("Expected failure for commands: ${input.replace("\n", "\\n")}") {
                runInput(input)
            }
        }
    }

    @Test
    fun propagatesIoExceptionForMissingOrDirectoryPaths() {
        val dir = Files.createTempDirectory("mars-rover-io-")
        try {
            val missing = dir.resolve("does-not-exist.txt")
            assertFailsWith<IOException> { MarsRover.execute(missing) }
            assertFailsWith<IOException> { MarsRover.execute(dir) }
        } finally {
            Files.walk(dir).sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }

    @Test
    fun independentCallsDoNotShareMutableState() {
        assertEquals("0 1 NORTH", runInput("5 5 0 0 NORTH\nM"))
        assertFailsWith<IllegalArgumentException> { runInput("5 5 0 0 NORTH\nINVALID") }
        assertEquals("0 1 NORTH", runInput("5 5 0 0 NORTH\nM"))
        assertEquals("2 0 EAST", runInput("5 4 4 1 EAST\nMMRMLM"))
    }
}
