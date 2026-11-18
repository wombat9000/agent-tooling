---
name: reviewing-design
description: "Reviews existing code for concrete design friction and justified improvements to responsibility boundaries, interfaces, and locality. Use when asked to assess module design or as the design-review stage of a substantive change; read-only by default."
---

# Reviewing Design

Find consequential design problems without manufacturing refactoring work.
Do not edit code or other repository files unless the user asks for changes.
This is a design assessment, not a substitute for correctness review or testing.

Load [writing-code](../writing-code/SKILL.md), read its
[module-design reference](../writing-code/reference/module-design.md), and read
the applicable language references as it directs. Assess against those construction
principles rather than restating them here.

## Establish the scope

Read the requested change or concern, relevant requirements, repository guidance,
and recorded design decisions. Follow the affected code into its callers and
tests; do not judge a declaration in isolation. Distinguish problems introduced
by a change from pre-existing problems. Stay within the requested review scope.

## Investigate actual friction

Before recommending restructuring, identify who calls the code, what they must
know, and the specific reading or change difficulty. Use the questions that fit
the code, not a checklist that must produce a finding for every item:

- Can the domain's construction and transition paths preserve its invariants,
  or must callers reconstruct rules and remember preparatory steps?
- Does orchestration express meaningful operations, or must the reader also
  decipher parsing, validation, or execution details to follow the workflow?
- Does understanding or changing one operation require navigating unrelated
  responsibilities or many thin layers? What knowledge crosses those boundaries?
- For a concrete change relevant to the requirements or observed maintenance,
  what would need to change together? Would a different boundary concentrate that
  knowledge without exposing more implementation detail?

A long method, several classes, or multiple responsibilities in one file are
signals to investigate, not findings by themselves. Do not invent future
requirements to justify a preferred structure.

## Compare the smallest useful alternatives

Compare keeping the current structure with the smallest useful split or
consolidation. Apply the deletion test from the module-design reference to suspect layers.
Explain the proposed responsibility, the complexity it hides, and what stays
private. Account for added concepts, navigation, coupling, or wider visibility.

Recommend a change only when the concrete benefit outweighs its cost. Keeping a
cohesive single file and consolidating fragmented code are valid outcomes, too.

## Report evidence and tradeoffs

For each recommendation, provide:

- A code location and the specific reading or change friction.
- Its consequence and the construction principle involved.
- The smallest useful improvement, its tradeoff, and why it is worth making.

Separate consequential problems from optional alternatives where the existing
design is defensible. State uncertainty rather than asserting unsupported costs.
If no material design problems were found, say so; do not fill a finding quota.
Return the assessment without automatically fixing it or starting a review loop.
