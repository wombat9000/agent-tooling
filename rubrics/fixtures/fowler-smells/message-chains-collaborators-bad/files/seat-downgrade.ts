interface QuotaLedger {
  getRemainingSeats(): number;
  decrementRemainingSeats(delta: number): void;
}
interface InvoiceScheduler {
  rescheduleNextRun(isoDate: string): void;
}
interface SubscriptionManager {
  getQuotaLedger(): QuotaLedger;
  getInvoiceScheduler(): InvoiceScheduler;
}
interface BillingController {
  getSubscriptionManager(): SubscriptionManager;
}
interface EmailDispatcher {
  enqueueNotice(recipient: string, message: string): void;
}
interface ChannelRegistry {
  getEmailDispatcher(): EmailDispatcher;
}
interface NotificationHub {
  getChannelRegistry(): ChannelRegistry;
}
interface WorkspaceContext {
  getBillingController(): BillingController;
  getNotificationHub(): NotificationHub;
}

export function downgradeWorkspaceSeats(
  workspace: WorkspaceContext,
  seatsToRemove: number,
  nextBillingDate: string,
  adminEmail: string,
): void {
  const available = workspace.getBillingController().getSubscriptionManager().getQuotaLedger().getRemainingSeats();
  if (available < seatsToRemove) {
    throw new Error('Cannot remove more seats than available');
  }
  workspace.getBillingController().getSubscriptionManager().getQuotaLedger().decrementRemainingSeats(seatsToRemove);
  workspace.getBillingController().getSubscriptionManager().getInvoiceScheduler().rescheduleNextRun(nextBillingDate);
  workspace.getNotificationHub().getChannelRegistry().getEmailDispatcher().enqueueNotice(
    adminEmail,
    `Removed ${seatsToRemove} seats; next cycle ${nextBillingDate}`,
  );
}
