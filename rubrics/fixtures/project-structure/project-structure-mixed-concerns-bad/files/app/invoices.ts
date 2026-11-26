import { Router } from 'express';
import { Pool } from 'pg';
import { createTransport } from 'nodemailer';

const db = new Pool();
const mailer = createTransport({ jsonTransport: true });

export function mountInvoiceEndpoints(router: Router): void {
  router.post('/invoices', async (req, res) => {
    const cents = Number(req.body.cents ?? 0);
    const lateFee = cents > 10_000 ? 500 : 0;
    await db.query('INSERT INTO invoices(cents, late_fee) VALUES ($1, $2)', [cents, lateFee]);
    await mailer.sendMail({ to: String(req.body.email), subject: 'Invoice', text: String(cents + lateFee) });
    res.json({ total: cents + lateFee });
  });
}
