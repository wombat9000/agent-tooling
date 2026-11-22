package catalog

/** A stock-keeping unit code: three uppercase letters, a hyphen and four digits, e.g. `ABC-1234`. */
@JvmInline
value class Sku(val code: String) {
    init {
        require(isWellFormed(code)) { "not a well-formed SKU: $code" }
    }

    companion object {
        /** Whether [code] has the SKU format described on [Sku]. */
        fun isWellFormed(code: String): Boolean =
            code.length == 8 &&
                code.substring(0, 3).all { it in 'A'..'Z' } &&
                code[3] == '-' &&
                code.substring(4).all { it.isDigit() }
    }
}
