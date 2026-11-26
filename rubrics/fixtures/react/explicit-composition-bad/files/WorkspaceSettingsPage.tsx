import { useState } from 'react';
import type { WorkspaceModel } from './types';

interface WorkspaceSettingsPageProps {
  workspace: WorkspaceModel;
  isOwner: boolean;
  onSaveProfile: (name: string, region: 'us' | 'eu') => Promise<void>;
  onUpdateBilling: (plan: WorkspaceModel['plan'], seats: number, email: string) => Promise<void>;
  onCreateKey: (label: string) => Promise<void>;
  onRevokeKey: (keyId: string) => Promise<void>;
  onSaveWebhook: (url: string, secret: string) => Promise<void>;
  onDeleteWorkspace: () => Promise<void>;
}

export function WorkspaceSettingsPage({
  workspace,
  isOwner,
  onSaveProfile,
  onUpdateBilling,
  onCreateKey,
  onRevokeKey,
  onSaveWebhook,
  onDeleteWorkspace,
}: WorkspaceSettingsPageProps) {
  const [name, setName] = useState(workspace.name);
  const [region, setRegion] = useState<'us' | 'eu'>(workspace.region);
  const [plan, setPlan] = useState(workspace.plan);
  const [seats, setSeats] = useState(workspace.seats);
  const [billingEmail, setBillingEmail] = useState(workspace.billingEmail);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [keyFilter, setKeyFilter] = useState<'all' | 'active'>('active');
  const [webhookUrl, setWebhookUrl] = useState(workspace.webhookUrl);
  const [webhookSecret, setWebhookSecret] = useState(workspace.webhookSecret);
  const [showSecret, setShowSecret] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [activeBanner, setActiveBanner] = useState<string | null>(null);

  const visibleKeys = keyFilter === 'active'
    ? workspace.apiKeys.filter((k) => !k.revoked)
    : workspace.apiKeys;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold">{workspace.name} settings</h1>
          <p className="text-sm text-slate-500">Workspace ID: {workspace.id}</p>
        </div>
        {activeBanner ? (
          <div role="status" className="rounded bg-emerald-50 px-3 py-1 text-sm text-emerald-800">
            {activeBanner}
            <button type="button" className="ml-2 underline" onClick={() => setActiveBanner(null)}>Close</button>
          </div>
        ) : null}
      </div>

      <section className="rounded-lg border p-5 space-y-4">
        <h2 className="text-lg font-semibold">General profile</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="ws-name" className="block text-sm font-medium">Workspace name</label>
            <input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
          </div>
          <div>
            <label htmlFor="ws-region" className="block text-sm font-medium">Data region</label>
            <select id="ws-region" value={region} onChange={(e) => setRegion(e.target.value as 'us' | 'eu')} className="mt-1 w-full rounded border px-3 py-2">
              <option value="us">United States</option>
              <option value="eu">Europe</option>
            </select>
          </div>
        </div>
        <button type="button" onClick={async () => { await onSaveProfile(name, region); setActiveBanner('Profile saved'); }} className="rounded bg-slate-900 px-4 py-2 text-white">
          Save profile
        </button>
      </section>

      <section className="rounded-lg border p-5 space-y-4">
        <h2 className="text-lg font-semibold">Billing &amp; subscription</h2>
        {isOwner ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              {(['starter', 'team', 'enterprise'] as const).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setPlan(tier)}
                  className={plan === tier ? 'rounded border-2 border-slate-900 p-3 text-left' : 'rounded border p-3 text-left'}
                >
                  <div className="font-medium capitalize">{tier}</div>
                  <div className="text-xs text-slate-500">{tier === 'starter' ? 'Up to 5 seats' : tier === 'team' ? 'Up to 50 seats' : 'Unlimited'}</div>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ws-seats" className="block text-sm">Seats</label>
                <input id="ws-seats" type="number" min={1} value={seats} onChange={(e) => setSeats(Number(e.target.value))} className="mt-1 w-full rounded border px-3 py-2" />
              </div>
              <div>
                <label htmlFor="ws-billing-email" className="block text-sm">Invoice email</label>
                <input id="ws-billing-email" type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
              </div>
            </div>
            <button type="button" onClick={async () => { await onUpdateBilling(plan, seats, billingEmail); setActiveBanner('Billing updated'); }} className="rounded bg-slate-900 px-4 py-2 text-white">
              Update billing
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-600">Only workspace owners can modify billing plans.</p>
        )}
      </section>

      <section className="rounded-lg border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">API keys</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => setKeyFilter('active')} className={keyFilter === 'active' ? 'font-semibold underline' : ''}>Active</button>
            <button type="button" onClick={() => setKeyFilter('all')} className={keyFilter === 'all' ? 'font-semibold underline' : ''}>All</button>
          </div>
        </div>
        <div className="flex gap-2">
          <input placeholder="Key label" value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} className="flex-1 rounded border px-3 py-2" />
          <button type="button" disabled={!newKeyLabel.trim()} onClick={async () => { await onCreateKey(newKeyLabel.trim()); setNewKeyLabel(''); setActiveBanner('Key created'); }} className="rounded border px-4 py-2">
            Generate key
          </button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2">Label</th>
              <th className="py-2">Prefix</th>
              <th className="py-2">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {visibleKeys.length === 0 ? (
              <tr><td colSpan={4} className="py-4 text-center text-slate-500">No keys found</td></tr>
            ) : visibleKeys.map((item) => (
              <tr key={item.id} className="border-b">
                <td className="py-2">{item.label}</td>
                <td className="py-2 font-mono">{item.prefix}...</td>
                <td className="py-2">{item.revoked ? 'Revoked' : 'Active'}</td>
                <td className="py-2 text-right">
                  {!item.revoked ? (
                    <button type="button" onClick={() => void onRevokeKey(item.id)} className="text-red-700 underline">Revoke</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border p-5 space-y-4">
        <h2 className="text-lg font-semibold">Outbound webhooks</h2>
        <div>
          <label htmlFor="wh-url" className="block text-sm">Endpoint URL</label>
          <input id="wh-url" type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <div>
          <label htmlFor="wh-secret" className="block text-sm">Signing secret</label>
          <div className="mt-1 flex gap-2">
            <input id="wh-secret" type={showSecret ? 'text' : 'password'} value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} className="flex-1 rounded border px-3 py-2" />
            <button type="button" onClick={() => setShowSecret((prev) => !prev)} className="rounded border px-3 py-2">
              {showSecret ? 'Hide' : 'Reveal'}
            </button>
          </div>
        </div>
        <button type="button" onClick={async () => { await onSaveWebhook(webhookUrl, webhookSecret); setActiveBanner('Webhook updated'); }} className="rounded bg-slate-900 px-4 py-2 text-white">
          Save webhook
        </button>
      </section>

      {isOwner ? (
        <section className="rounded-lg border border-red-300 bg-red-50 p-5 space-y-3">
          <h2 className="text-lg font-semibold text-red-900">Danger zone</h2>
          <p className="text-sm text-red-800">Deleting a workspace permanently destroys all projects and audit logs.</p>
          <button type="button" onClick={() => setDeleteDialogOpen(true)} className="rounded bg-red-700 px-4 py-2 text-white">
            Delete workspace
          </button>
          {deleteDialogOpen ? (
            <div role="dialog" aria-modal="true" className="fixed inset-0 flex items-center justify-center bg-black/50 p-4">
              <div className="w-full max-w-md rounded-lg bg-white p-6 space-y-4">
                <h3 className="text-lg font-semibold">Confirm permanent deletion</h3>
                <p className="text-sm">Type <strong>{workspace.name}</strong> to confirm.</p>
                <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="w-full rounded border px-3 py-2" />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setDeleteDialogOpen(false); setConfirmName(''); }} className="rounded border px-3 py-1.5">Cancel</button>
                  <button type="button" disabled={confirmName !== workspace.name} onClick={() => void onDeleteWorkspace()} className="rounded bg-red-700 px-3 py-1.5 text-white">Confirm delete</button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
