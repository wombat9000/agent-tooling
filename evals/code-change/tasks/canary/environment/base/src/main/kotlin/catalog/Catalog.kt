package catalog

/** A product that can be sold. */
data class Product(val sku: Sku, val name: String)

/** An immutable set of products, looked up by SKU. */
class Catalog(private val products: Map<Sku, Product> = emptyMap()) {
    /** Returns a catalog that also contains [product], replacing any product with the same SKU. */
    fun add(product: Product): Catalog = Catalog(products + (product.sku to product))

    fun find(sku: Sku): Product? = products[sku]
}
