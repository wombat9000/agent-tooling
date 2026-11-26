package com.acme.ops

class MaintenancePlanner {
    fun scheduleMaintenance(
        clusterId: String,
        regionCode: String,
        startDateIso: String,
        endDateIso: String,
        timeZoneId: String,
        ownerEmail: String,
        notifyCustomers: Boolean = true,
        drainTrafficFirst: Boolean = true,
        maxParallelNodes: Int = 2,
    ): String {
        val minutes = estimateDowntimeMinutes(startDateIso, endDateIso, timeZoneId, maxParallelNodes)
        val banner = formatWindowBanner(startDateIso, endDateIso, timeZoneId, regionCode)
        return "$clusterId|$banner|$ownerEmail|$notifyCustomers|$drainTrafficFirst|$minutes"
    }

    fun estimateDowntimeMinutes(
        startDateIso: String,
        endDateIso: String,
        timeZoneId: String,
        maxParallelNodes: Int,
    ): Int {
        val base = if (startDateIso == endDateIso) 30 else 120
        val tzOffsetPenalty = if (timeZoneId == "UTC") 0 else 5
        return (base / maxParallelNodes.coerceAtLeast(1)) + tzOffsetPenalty
    }

    fun formatWindowBanner(
        startDateIso: String,
        endDateIso: String,
        timeZoneId: String,
        regionCode: String,
    ): String {
        return "[$regionCode] $startDateIso to $endDateIso ($timeZoneId)"
    }
}
