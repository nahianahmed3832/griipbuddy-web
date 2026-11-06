import 'server-only';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { checkoutEnabled } from './runtime';
import { CheckoutError, type CheckoutOrder, type Status } from './contracts';

let db: Database.Database | undefined;

export function checkoutDb() {
  if (!checkoutEnabled()) throw new CheckoutError(404, 'Checkout is not available for this catalog.');
  if (db) return db;
  const root = process.env.GRIIPBUDDY_CHECKOUT_DIR!;
  if (!isAbsolute(root)) throw new Error('Checkout storage must be an absolute private path.');
  const dir = lstatSync(root);
  if (!dir.isDirectory() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) {
    throw new Error('Checkout storage must be an owned directory with mode 0700.');
  }
  const file = join(realpathSync(root), 'checkout.sqlite');
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).nlink !== 1)) throw new Error('Invalid checkout storage file.');
  const opened = new Database(file, { timeout: 5000 });
  chmodSync(file, 0o600);
  opened.pragma('journal_mode = WAL');
  opened.pragma('foreign_keys = ON');
  opened.exec(`
    CREATE TABLE IF NOT EXISTS stock (
      product TEXT NOT NULL, variant TEXT NOT NULL, initial INTEGER NOT NULL,
      on_hand INTEGER NOT NULL CHECK(on_hand >= 0),
      held INTEGER NOT NULL CHECK(held >= 0 AND held <= on_hand), PRIMARY KEY(product,variant)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL,
      expiry INTEGER, document TEXT NOT NULL, UNIQUE(owner,idem)
    );
    CREATE INDEX IF NOT EXISTS order_expiry ON orders(expiry) WHERE expiry IS NOT NULL;
    CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY REFERENCES orders(id), image BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_refs (
      kind TEXT NOT NULL, ref TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id), PRIMARY KEY(kind,ref)
    );
    CREATE TABLE IF NOT EXISTS checkout_preferences (
      id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkout_admin_history (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      provider TEXT NOT NULL, id TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id), hash TEXT NOT NULL,
      PRIMARY KEY(provider,id)
    );
  `);
  db = opened;
  return opened;
}

export function transaction<T>(work: (database: Database.Database) => T): T {
  return checkoutDb().transaction(() => work(checkoutDb())).immediate();
}

export function orderRecord(database: Database.Database, id: string) {
  const row = database.prepare('SELECT owner, document FROM orders WHERE id = ?').get(id) as { owner: string; document: string } | undefined;
  if (!row) throw new CheckoutError(404, 'Order not found.');
  return { owner: row.owner, order: JSON.parse(row.document) as CheckoutOrder };
}

export function saveOrder(database: Database.Database, order: CheckoutOrder) {
  database.prepare('UPDATE orders SET expiry=?, document=? WHERE id=?').run(order.expiresAt, JSON.stringify(order), order.id);
}

export function mark(order: CheckoutOrder, status: Status) {
  order.status = status;
  order.history.push({ status, date: new Date().toISOString() });
}

export function moveStock(database: Database.Database, order: CheckoutOrder, action: 'release' | 'dispatch' | 'return') {
  const sql = {
    release: 'UPDATE stock SET held=held-? WHERE product=? AND variant=?',
    dispatch: 'UPDATE stock SET on_hand=on_hand-?, held=held-? WHERE product=? AND variant=?',
    return: 'UPDATE stock SET on_hand=on_hand+? WHERE product=? AND variant=?',
  }[action];
  for (const item of order.lines) {
    const args = action === 'dispatch' ? [item.quantity, item.quantity, item.productId, item.variantId]
      : [item.quantity, item.productId, item.variantId];
    if (database.prepare(sql).run(...args).changes !== 1) throw new Error('Missing inventory row.');
  }
}

export function releaseExpired() {
  if (!checkoutDb().prepare('SELECT 1 FROM orders WHERE expiry <= ? LIMIT 1').get(Date.now())) return;
  transaction((database) => {
    const rows = database.prepare('SELECT document FROM orders WHERE expiry <= ?').all(Date.now()) as { document: string }[];
    for (const row of rows) {
      const order: CheckoutOrder = JSON.parse(row.document);
      moveStock(database, order, 'release');
      mark(order, 'expired');
      order.expiresAt = null;
      order.payment = 'void';
      saveOrder(database, order);
    }
  });
}

export function seedStock(database: Database.Database, product: string, variant: string, initial: number) {
  database.prepare('INSERT OR IGNORE INTO stock(product,variant,initial,on_hand,held) VALUES(?,?,?,?,0)')
    .run(product, variant, initial, initial);
}

export function syntheticStock(product: string, variant: string, initial: number | null) {
  if (!checkoutEnabled() || initial === null) return initial;
  releaseExpired();
  const database = checkoutDb();
  const read = database.prepare('SELECT on_hand-held AS available FROM stock WHERE product=? AND variant=?');
  let row = read.get(product, variant) as { available: number } | undefined;
  if (!row) {
    seedStock(database, product, variant, initial);
    row = read.get(product, variant) as { available: number };
  }
  return row.available;
}

export function newOrderId() { return randomUUID(); }

export function claimReference(database: Database.Database, kind: string, ref: string, orderId: string) {
  const inserted = database.prepare('INSERT OR IGNORE INTO payment_refs(kind,ref,order_id) VALUES(?,?,?)').run(kind, ref, orderId);
  if (inserted.changes !== 1) throw new CheckoutError(409, 'That payment reference has already been submitted.');
}
