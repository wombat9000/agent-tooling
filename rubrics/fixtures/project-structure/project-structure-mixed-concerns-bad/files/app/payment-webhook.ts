import { Router } from 'express';
import { Pool } from 'pg';

const db = new Pool();

export function registerWebhookAndReconcileLedger(router: Router): void {
  router.post('/webhooks/payments', async (req, res) => {
    await db.query('UPDATE ledger SET settled = true WHERE ref = $1', [req.body.ref]);
    res.status(204).end();
  });
}
