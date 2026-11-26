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

export function calculateMonthlyAccruals(employees: EmployeeLeaveInput[]): LeaveAccrualResult[] {
  const results: LeaveAccrualResult[] = [];

  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];

    // Section 1: base monthly accrual and tenure bonus
    let g = 0;
    if (emp.employmentType === 'full_time') {
      g = 12;
      if (emp.tenureMonths >= 60) {
        g = g + 4;
      } else if (emp.tenureMonths >= 24) {
        g = g + 2;
      }
    } else if (emp.employmentType === 'part_time') {
      g = 6;
      if (emp.tenureMonths >= 36) {
        g = g + 2;
      }
    } else if (emp.employmentType === 'contractor') {
      g = 0;
    } else if (emp.employmentType === 'probation') {
      g = 4;
    } else {
      throw new Error('Unsupported employment type: ' + emp.employmentType);
    }

    // Section 2: parental leave freeze and unpaid leave adjustment
    let a = 0;
    let d = emp.unpaidLeaveDaysThisMonth;
    if (d < 0) d = 0;
    if (d > 20) d = 20;
    emp.unpaidLeaveDaysThisMonth = d;

    if (emp.onParentalLeave) {
      a = 0;
    } else {
      if (emp.employmentType === 'full_time') {
        a = Math.round(((g * (20 - d)) / 20) * 4) / 4;
      } else if (emp.employmentType === 'part_time') {
        a = Math.round(((g * (20 - d)) / 20) * 4) / 4;
      } else if (emp.employmentType === 'contractor') {
        a = 0;
      } else if (emp.employmentType === 'probation') {
        if (emp.unpaidLeaveDaysThisMonth > 0) {
          a = 0;
        } else {
          a = g;
        }
      }
    }

    // Section 3: balance cap, forfeiture, and carryover eligibility
    const rb = emp.currentBalanceHours + a;
    let cap = 0;
    let c = false;

    if (emp.employmentType === 'full_time') {
      c = true;
      if (emp.isYearEnd) {
        cap = 160;
      } else {
        cap = 240;
      }
    } else if (emp.employmentType === 'part_time') {
      c = true;
      if (emp.isYearEnd) {
        cap = 80;
      } else {
        cap = 120;
      }
    } else if (emp.employmentType === 'contractor') {
      c = false;
      cap = 0;
    } else if (emp.employmentType === 'probation') {
      c = false;
      if (emp.isYearEnd) {
        cap = 0;
      } else {
        cap = 40;
      }
    }

    let eb = rb;
    let f = 0;
    if (rb > cap) {
      eb = cap;
      f = rb - cap;
    }

    emp.currentBalanceHours = eb;

    results.push({
      employeeId: emp.employeeId,
      employmentType: emp.employmentType,
      accruedHours: a,
      forfeitedHours: f,
      endingBalanceHours: eb,
      eligibleForCarryover: c,
    });
  }

  return results;
}
