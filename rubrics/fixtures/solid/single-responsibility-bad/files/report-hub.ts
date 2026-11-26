import type { ArchiveStore, MailTransport } from './ports';
import type { UsageSample } from './types';

export class ReportHub {
  private readonly mail: MailTransport;
  private readonly archive: ArchiveStore;

  constructor(mail: MailTransport, archive: ArchiveStore) {
    this.mail = mail;
    this.archive = archive;
  }

  async runEndOfDayBatch(samples: readonly UsageSample[], recipientEmail: string, dateKey: string) {
    let totalRequests = 0;
    let totalOverageCents = 0;
    const csvLines = ['tenant_id,requests,errors,overage_cents'];
    const htmlRows: string[] = [];

    for (const sample of samples) {
      totalRequests += sample.requestCount;
      const overageRequests = Math.max(0, sample.requestCount - sample.planLimit);
      const overageCents = Math.ceil(overageRequests / 1_000) * 45;
      totalOverageCents += overageCents;
      csvLines.push(`${sample.tenantId},${sample.requestCount},${sample.errorCount},${overageCents}`);
      htmlRows.push(`<tr><td>${sample.tenantId}</td><td>${sample.requestCount}</td><td>$${(overageCents / 100).toFixed(2)}</td></tr>`);
    }

    await this.archive.putCsv(`usage-${dateKey}.csv`, csvLines.join('\n'));
    const prunedArchives = await this.archive.deleteOlderThanDays(90);

    const htmlBody = `<h1>Usage Report ${dateKey}</h1><p>Total requests: ${totalRequests}, Overage: $${(totalOverageCents / 100).toFixed(2)}</p><table>${htmlRows.join('')}</table>`;
    await this.mail.send(recipientEmail, `Daily Usage & Billing ${dateKey}`, htmlBody);
    return { totalRequests, totalOverageCents, prunedArchives };
  }
}
