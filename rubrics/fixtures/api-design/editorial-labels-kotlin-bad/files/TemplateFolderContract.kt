package com.acme.templates.api

// Kept as a fixed enum so the sidebar displays folders in a predictable editorial order.
enum class TemplateFolder(val displayOrder: Int) {
    WELCOME_NOTES(1),
    WORKSHOP_GUIDES(2),
    NEWSLETTER_ARCHIVE(3),
    SEASONAL_PROMOS(4),
}

data class SaveTemplateRequest(
    val title: String,
    val body: String,
    val folder: TemplateFolder,
)

fun parseTemplateFolder(raw: String): TemplateFolder {
    return TemplateFolder.entries.firstOrNull { it.name.equals(raw.trim(), ignoreCase = true) }
        ?: throw IllegalArgumentException("Unknown template folder: $raw")
}

fun sortTemplatesByFolder(templates: List<SaveTemplateRequest>): List<SaveTemplateRequest> {
    return templates.sortedBy { it.folder.displayOrder }
}
