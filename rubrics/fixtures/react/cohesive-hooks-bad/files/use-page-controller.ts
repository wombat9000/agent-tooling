import { useEffect, useRef, useState } from 'react';

interface LineItem {
  sku: string;
  unitCents: number;
  quantity: number;
  taxExempt: boolean;
}

export function usePageController(
  workspaceId: string,
  navigate: (path: string) => void,
  showToast: (message: string) => void,
) {
  const [sessionValid, setSessionValid] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [items, setItems] = useState<LineItem[]>([]);
  const [couponCode, setCouponCode] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [exporting, setExporting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(async () => {
      const resp = await fetch('/api/session/heartbeat');
      if (resp.status === 401) {
        setSessionValid(false);
        showToast('Session expired');
        navigate('/login');
      }
    }, 30_000);
    return () => window.clearInterval(id);
  }, [navigate, showToast]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  async function checkoutInvoice(customerRegion: string) {
    let subtotal = 0;
    let taxable = 0;
    for (const item of items) {
      const lineTotal = item.unitCents * item.quantity;
      subtotal += lineTotal;
      if (!item.taxExempt) taxable += lineTotal;
    }
    const discountRate = couponCode === 'ANNUAL20' ? 0.2 : couponCode === 'LAUNCH10' ? 0.1 : 0;
    const discountedSubtotal = Math.round(subtotal * (1 - discountRate));
    const taxRate = customerRegion === 'EU' ? 0.2 : customerRegion === 'CA' ? 0.08 : 0.05;
    const totalCents = discountedSubtotal + Math.round(taxable * (1 - discountRate) * taxRate);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/invoices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Retry-Attempt': String(attempt) },
          body: JSON.stringify({ totalCents, items, couponCode }),
        });
        if (res.ok) {
          showToast('Invoice submitted');
          setSidebarOpen(false);
          searchInputRef.current?.focus();
          navigate(`/workspaces/${workspaceId}/receipt`);
          return;
        }
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    showToast(lastError instanceof Error ? lastError.message : 'Checkout failed');
  }

  async function downloadCsv() {
    setExporting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/export?q=${encodeURIComponent(searchQuery)}&sort=${sortOrder}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      showToast('Export ready');
    } finally {
      setExporting(false);
    }
  }

  return {
    sessionValid,
    sidebarOpen,
    setSidebarOpen,
    searchQuery,
    setSearchQuery,
    sortOrder,
    setSortOrder,
    items,
    setItems,
    couponCode,
    setCouponCode,
    theme,
    setTheme,
    exporting,
    searchInputRef,
    checkoutInvoice,
    downloadCsv,
  };
}
