package billing

sealed class BillingFailure(message: String) : RuntimeException(message)

class InvalidBillingRequest(message: String) : BillingFailure(message)

class ResourceNotFound(message: String) : BillingFailure(message)

class BillingConflict(message: String) : BillingFailure(message)
