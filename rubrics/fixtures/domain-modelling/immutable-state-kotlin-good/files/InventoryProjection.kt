package com.acme.warehouse

data class StockMovement(val sku: String, val delta: Int)
data class StockLevel(val sku: String, val onHand: Int)

fun aggregateStockLevels(movements: List<StockMovement>): List<StockLevel> {
    val totals = linkedMapOf<String, Int>()
    for (movement in movements) {
        totals[movement.sku] = (totals[movement.sku] ?: 0) + movement.delta
    }
    return buildList(totals.size) {
        for ((sku, onHand) in totals) {
            add(StockLevel(sku = sku, onHand = onHand))
        }
    }
}

fun adjustStock(level: StockLevel, delta: Int): StockLevel {
    return level.copy(onHand = (level.onHand + delta).coerceAtLeast(0))
}

class StockLookupCache(private val fetchLevel: (String) -> StockLevel) {
    private val entries = HashMap<String, StockLevel>()

    fun get(sku: String): StockLevel {
        return entries.getOrPut(sku) { fetchLevel(sku) }
    }
}
