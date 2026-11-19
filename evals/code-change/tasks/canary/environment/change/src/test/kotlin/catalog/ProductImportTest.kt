package catalog

import kotlin.test.Test
import kotlin.test.assertNotNull

class ProductImportTest {
    @Test
    fun `imports products`() {
        val catalog = ProductImport.importLines(Catalog(), listOf("ABC-1234,Kettle", "bad,Toaster"))

        assertNotNull(catalog)
    }
}
