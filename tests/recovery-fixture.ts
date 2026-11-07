import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const ownerId = '00000000000000000000000f';

export async function withFixtureMongo<T>(work: (db: {
  collection: (name: string) => {
    findOne: (query: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    updateOne: (query: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };
}, id: (value: string) => unknown) => Promise<T>) {
  const root = process.env.GRIIPBUDDY_TEST_BACKEND_DIR;
  if (!root) throw new Error('Set GRIIPBUDDY_TEST_BACKEND_DIR to the local recovered backend with installed dependencies.');
  const { MongoClient, ObjectId } = createRequire(resolve(root, 'package.json'))('mongoose').mongo;
  const client = new MongoClient('mongodb://127.0.0.1:38117/griipbuddy_fixture?replicaSet=griip-recovery&directConnection=true', { serverSelectionTimeoutMS: 2000 });
  try {
    const db = client.db('griipbuddy_fixture');
    const topology = await db.admin().command({ hello: 1 });
    if (topology.setName !== 'griip-recovery' || topology.me !== '127.0.0.1:38117') throw new Error('Unexpected synthetic database topology.');
    if (!await db.collection('users').findOne({ _id: new ObjectId(ownerId), phone_number: '01000000002', role: 'USER' })) {
      throw new Error('Synthetic customer fixture not found.');
    }
    return await work(db, (value) => new ObjectId(value));
  } finally {
    await client.close();
  }
}
