# Cart Discount Specification

Compute the discounted payable total (in integer cents) for a cart subtotal:
- Reject negative subtotals (`subtotalCents < 0`) by throwing `RangeError`.
- Subtotals below 5000 cents ($50.00): 0% discount.
- Subtotals from 5000 to 9999 cents ($50.00–$99.99): 10% discount (rounded down to integer cents).
- Subtotals of 10000 cents ($100.00) or more: 20% discount (rounded down to integer cents).
- Maximum discount per order is capped at 4000 cents ($40.00).
