# Leave Accrual Calculator Refactoring

Refactor the legacy monthly leave-accrual calculator in `src/leave.ts` and add support for the **`sabbatical`** employment type.

## Public API

Keep `src/leave.ts` exporting the following public types and function:

```ts
export interface EmployeeLeaveInput {
  employeeId: string;
  employmentType: string;
  tenureMonths: number;
  currentBalanceHours: number;
  unpaidLeaveDaysThisMonth: number;
  onParentalLeave?: boolean;
  isYearEnd?: boolean;
}

export interface LeaveAccrualResult {
  employeeId: string;
  employmentType: string;
  accruedHours: number;
  forfeitedHours: number;
  endingBalanceHours: number;
  eligibleForCarryover: boolean;
}

export function calculateMonthlyAccruals(employees: EmployeeLeaveInput[]): LeaveAccrualResult[];
```

- Callers read the returned `LeaveAccrualResult[]` in input order (`[]` returns `[]`); they do not rely on any mutation of the input `employees` array or its objects.
- Throw an `Error` if an employee specifies an unsupported `employmentType`.

## Accrual and Balance Rules

Supported employment types are `'full_time'`, `'part_time'`, `'contractor'`, `'probation'`, and the new **`'sabbatical'`** type.

A standard working month has `20` workdays. Whenever proration is applied, round hours to the nearest quarter-hour (`0.25` hr) using `Math.round(hours * 4) / 4`.

### 1. Employment Type Table

| Employment Type | Base Monthly Accrual (hrs) | Tenure Milestone Bonus (hrs/mo) | Unpaid Leave Rule | Monthly Balance Cap (hrs) | Year-End Carryover Cap (hrs) | `eligibleForCarryover` |
|---|---:|---|---|---:|---:|---|
| `full_time` | `12` | `>= 60` mos: `+4`; `24–59` mos: `+2`; `< 24` mos: `0` | Prorated by `(20 - clampedDays) / 20`, rounded to nearest `0.25` hr | `240` | `160` | `true` |
| `part_time` | `6` | `>= 36` mos: `+2`; `< 36` mos: `0` | Prorated by `(20 - clampedDays) / 20`, rounded to nearest `0.25` hr | `120` | `80` | `true` |
| `contractor` | `0` | `0` | Always `0` accrued | `0` | `0` | `false` |
| `probation` | `4` | `0` | Any unpaid leave (`unpaidLeaveDaysThisMonth > 0`) sets accrual to `0` | `40` | `0` | `false` |
| `sabbatical` *(new)* | `3` if `tenureMonths >= 36`, else `0` | `0` | Unpaid leave days do not reduce sabbatical accrual | `160` | `120` if `tenureMonths >= 36`, else `0` | `tenureMonths >= 36` |

### 2. Monthly Accrual (`accruedHours`)

1. **Parental leave freeze:** If `onParentalLeave === true`, `accruedHours = 0` for every employment type (including `sabbatical`). Existing balance and balance/year-end caps still apply.
2. **Gross monthly hours:** Compute `baseMonthlyHours + tenureBonusHours` from the table above.
   - For `sabbatical`, employees with `tenureMonths < 36` are ineligible for sabbatical accrual (`grossHours = 0`), while employees with `tenureMonths >= 36` earn `3` hours per month.
3. **Unpaid leave adjustment:**
   - For `full_time` and `part_time`: clamp `unpaidLeaveDaysThisMonth` to `[0, 20]` (`clampedDays = Math.min(20, Math.max(0, unpaidLeaveDaysThisMonth))`), then compute:
     `accruedHours = Math.round((grossHours * (20 - clampedDays) / 20) * 4) / 4`.
   - For `probation`: if `unpaidLeaveDaysThisMonth > 0`, `accruedHours = 0`; otherwise `accruedHours = grossHours`.
   - For `contractor`: `accruedHours = 0`.
   - For `sabbatical`: unpaid leave days do not reduce sabbatical accrual (`accruedHours = grossHours`).

### 3. Balance Cap, Forfeiture, and Carryover

1. Compute pre-cap balance: `rawBalance = currentBalanceHours + accruedHours`.
2. Determine the active balance cap:
   - When `isYearEnd === true`, use the **year-end carryover cap** from the table (`120` for `sabbatical` when `tenureMonths >= 36`, or `0` when `tenureMonths < 36`).
   - Otherwise (mid-year), use the **monthly balance cap** from the table (`160` for `sabbatical` regardless of tenure).
3. Compute ending balance and forfeited hours:
   - `endingBalanceHours = Math.min(rawBalance, activeCap)`.
   - `forfeitedHours = Math.max(0, rawBalance - endingBalanceHours)`.
4. Determine `eligibleForCarryover` from the table (`true` for `full_time` and `part_time`, `false` for `contractor` and `probation`, and `tenureMonths >= 36` for `sabbatical`).

## Worked Examples

1. **Full-time mid-year near monthly cap with unpaid leave proration:**
   - Input: `{ employeeId: 'EMP-1', employmentType: 'full_time', tenureMonths: 30, currentBalanceHours: 235, unpaidLeaveDaysThisMonth: 3 }`
   - Gross accrual: `12 + 2 = 14`; prorated: `14 * 17 / 20 = 11.9` -> rounded to nearest `0.25` hr = `12`.
   - `rawBalance = 235 + 12 = 247`, mid-year cap = `240`.
   - Result: `accruedHours = 12`, `forfeitedHours = 7`, `endingBalanceHours = 240`, `eligibleForCarryover = true`.

2. **Part-time year-end with tenure milestone and unpaid leave:**
   - Input: `{ employeeId: 'EMP-2', employmentType: 'part_time', tenureMonths: 40, currentBalanceHours: 78, unpaidLeaveDaysThisMonth: 5, isYearEnd: true }`
   - Gross accrual: `6 + 2 = 8`; prorated: `8 * 15 / 20 = 6`.
   - `rawBalance = 78 + 6 = 84`, year-end cap = `80`.
   - Result: `accruedHours = 6`, `forfeitedHours = 4`, `endingBalanceHours = 80`, `eligibleForCarryover = true`.

3. **Sabbatical eligible (36 months) at year-end with unpaid leave days:**
   - Input: `{ employeeId: 'EMP-3', employmentType: 'sabbatical', tenureMonths: 36, currentBalanceHours: 125, unpaidLeaveDaysThisMonth: 10, isYearEnd: true }`
   - Eligible (`36 >= 36`), unpaid leave does not reduce accrual -> `accruedHours = 3`.
   - `rawBalance = 125 + 3 = 128`, year-end cap = `120`.
   - Result: `accruedHours = 3`, `forfeitedHours = 8`, `endingBalanceHours = 120`, `eligibleForCarryover = true`.

4. **Sabbatical ineligible (24 months) at year-end vs mid-year:**
   - Mid-year (`currentBalanceHours: 50`, `isYearEnd: false`): `accruedHours = 0`, `forfeitedHours = 0`, `endingBalanceHours = 50`, `eligibleForCarryover = false`.
   - Year-end (`currentBalanceHours: 50`, `isYearEnd: true`): `accruedHours = 0`, `forfeitedHours = 50`, `endingBalanceHours = 0`, `eligibleForCarryover = false`.

## Tests and Verification

- Keep production code under `src/` and add thorough unit tests under `tests/` using Node's built-in test runner (`node:test` and `node:assert/strict`) covering all employment types, tenure milestones, unpaid-leave rules, parental-leave freezes, mid-year vs year-end caps, and edge cases.
- Verify with `pnpm typecheck` and `pnpm test`.
