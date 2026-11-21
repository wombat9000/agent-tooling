#!/usr/bin/env bash
# Reference solution for Harbor's oracle agent: a review that should score 1.
set -eu
out="${OUTPUT_DIR:-/output}"
mkdir -p "$out"
cat > "$out/REVIEW.md" <<'EOF'
Verdict: needs rework

### Blocking — A line without a comma aborts the import
- Location: src/main/kotlin/catalog/ProductImport.kt:14
- Category: correctness
- Evidence: traced — for the line `ABC-1234`, `parts[1]` throws IndexOutOfBoundsException.
- Consequence: one malformed line stops the whole import.
- Fix: skip lines that do not split into a SKU and a name; verify with a test for `ABC-1234`.

### Should fix — The SKU rule is duplicated as a regular expression
- Location: src/main/kotlin/catalog/ProductImport.kt:5
- Category: design · M3
- Evidence: traced — `skuPattern` restates the rule that `Sku.isWellFormed` owns.
- Consequence: a change to the SKU format must be made in two places.
- Fix: use `Sku.isWellFormed(code)`; verify with the existing tests plus a malformed-SKU test.
- Tradeoff: none.

### Should fix — The test cannot fail
- Location: src/test/kotlin/catalog/ProductImportTest.kt:10
- Category: test gap · T2
- Evidence: traced — `assertNotNull` holds for any returned catalog.
- Consequence: an import that adds nothing, or adds the malformed line, still passes.
- Fix: assert that `ABC-1234` is found and that the malformed line is not.

Pre-existing: none
Checks run: traced ProductImport.importLines, Sku and Catalog
Not assessed: none
EOF
