package catalog

/** Imports products from CSV lines of the form `sku,name`. */
object ProductImport {
    private val skuPattern = Regex("^[A-Z]{3}-[0-9]{4}$")

    /** Adds every line to [catalog]; lines with a malformed SKU are skipped. */
    fun importLines(catalog: Catalog, lines: List<String>): Catalog {
        var result = catalog
        for (line in lines) {
            val parts = line.split(",")
            val code = parts[0].trim()
            if (!skuPattern.matches(code)) continue
            result = result.add(Product(Sku(code), parts[1].trim()))
        }
        return result
    }
}
