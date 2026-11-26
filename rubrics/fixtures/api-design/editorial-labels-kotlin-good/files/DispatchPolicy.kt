package com.acme.support.api

enum class DispatchQueue {
    URGENT_TRIAGE,
    FRAUD_REVIEW,
    STANDARD_FULFILLMENT,
}

enum class ReviewGrade {
    INCOMPLETE,
    SATISFACTORY,
    EXEMPLARY,
}

val SUGGESTED_COLLECTION_LABELS: List<String> = listOf("Getting Started", "Reference", "Archive")

data class CaseAssignmentRequest(
    val caseId: String,
    val queue: DispatchQueue,
    val collectionLabel: String?,
)

data class QueueSla(val maxResponseMinutes: Int, val requiresDualApproval: Boolean)

fun resolveQueueSla(queue: DispatchQueue): QueueSla = when (queue) {
    DispatchQueue.URGENT_TRIAGE -> QueueSla(maxResponseMinutes = 15, requiresDualApproval = true)
    DispatchQueue.FRAUD_REVIEW -> QueueSla(maxResponseMinutes = 60, requiresDualApproval = true)
    DispatchQueue.STANDARD_FULFILLMENT -> QueueSla(maxResponseMinutes = 480, requiresDualApproval = false)
}

fun gradePoints(grade: ReviewGrade): Int = when (grade) {
    ReviewGrade.INCOMPLETE -> 0
    ReviewGrade.SATISFACTORY -> 1
    ReviewGrade.EXEMPLARY -> 2
}

fun normalizeCollectionLabel(raw: String?): String? = raw?.trim()?.takeIf { it.isNotEmpty() }
