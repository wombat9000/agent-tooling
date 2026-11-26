import { usePageController } from './use-page-controller';

export function DashboardPage({
  workspaceId,
  navigate,
  showToast,
}: {
  workspaceId: string;
  navigate: (path: string) => void;
  showToast: (message: string) => void;
}) {
  const controller = usePageController(workspaceId, navigate, showToast);

  return (
    <main>
      <input
        ref={controller.searchInputRef}
        value={controller.searchQuery}
        onChange={(e) => controller.setSearchQuery(e.target.value)}
      />
      <button type="button" onClick={() => void controller.checkoutInvoice('US')}>
        Checkout
      </button>
      <button type="button" disabled={controller.exporting} onClick={() => void controller.downloadCsv()}>
        Export CSV
      </button>
    </main>
  );
}
