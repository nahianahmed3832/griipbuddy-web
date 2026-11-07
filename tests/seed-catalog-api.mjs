import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const backendPath = process.argv[2];
if (!backendPath) throw new Error('Pass the local recovered backend directory containing node_modules.');
const { MongoClient, ObjectId } = createRequire(resolve(backendPath, 'package.json'))('mongoose').mongo;
const id = (number) => new ObjectId(number.toString(16).padStart(24, '0'));
const namespace = 'griipbuddy_fixture';
const client = new MongoClient(
  'mongodb://127.0.0.1:38117/' + namespace + '?replicaSet=griip-recovery&directConnection=true',
  { serverSelectionTimeoutMS: 2000 },
);

async function main() {
  const db = client.db(namespace);
  const topology = await db.admin().command({ hello: 1 });
  assert.equal(topology.setName, 'griip-recovery');
  assert.equal(topology.me, '127.0.0.1:38117');
  const products = db.collection('products');
  const domestic = await products.findOne({ _id: id(3), slug: 'fixture-bd', sku: 'FIXTURE-BD' });
  const international = await products.findOne({ _id: id(4), slug: 'fixture-int', sku: 'FIXTURE-INT' });
  assert.ok(domestic && international, 'The existing synthetic recovery fixture must be present.');
  assert.ok(await db.collection('countries').findOne({ _id: id(19), name: 'Fixture US' }));
  assert.ok(await db.collection('variants').findOne({ _id: id(6), product: id(4), sku: 'FIXTURE-INT-BLUE' }));

  async function insert(collection, document) {
    const { _id, ...fields } = document;
    await db.collection(collection).updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
  }

  for (const [number, code, name, currency] of [
    [100, 'BD', 'Bangladesh', 'BDT'], [101, 'DE', 'Germany', 'EUR'], [102, 'AU', 'Australia', 'AUD'], [103, 'CA', 'Canada', 'USD'],
  ]) {
    await insert('countries', { _id: id(number), code, name, currency, is_active: code !== 'CA' });
  }
  await insert('brands', { _id: id(104), name: 'Fixture brand', is_active: true });
  await insert('sub_subcategories', {
    _id: id(105), slug: 'fixture-cases', name_en: 'Fixture cases', category: id(1), subcategory: id(2),
    is_published: true, third_subcategories: [id(106), id(107)],
  });
  await insert('third_subcategories', {
    _id: id(106), slug: 'fixture-blue-cases', name_en: 'Fixture blue cases', category: id(1), subcategory: id(2),
    sub_subcategory: id(105), is_published: true,
  });
  await insert('third_subcategories', {
    _id: id(107), slug: 'fixture-private', name_en: 'Fixture private', category: id(1), subcategory: id(2),
    sub_subcategory: id(105), is_published: false,
  });
  await db.collection('subcategories').updateOne({ _id: id(2) }, { $addToSet: { sub_subcategories: id(105) } });
  await products.updateOne({ _id: id(3), sku: 'FIXTURE-BD' }, { $set: { brand: id(104), sub_subcategory: id(105), third_subcategory: id(106) } });
  await products.updateOne({ _id: id(4), sku: 'FIXTURE-INT' }, {
    $addToSet: { available_countries: { $each: [id(101), id(102), id(103)] } },
    $set: { brand: id(104), sub_subcategory: id(105), third_subcategory: id(106), thumbnail: 'https://media.fixture.invalid/fixture-case.webp',
      short_videos: [
        { url: 'https://media.fixture.invalid/fixture-case.mp4', title: 'Case overview', format: 'mp4' },
        { url: 'https://blocked.fixture.invalid/unapproved.mp4', title: 'Unapproved', format: 'mp4' },
      ] },
  });
  await db.collection('variants').updateOne({ _id: id(6), sku: 'FIXTURE-INT-BLUE' }, {
    $set: {
      'prices.EUR': { regular_price: 15, sale_price: 12 },
      image: 'https://media.fixture.invalid/fixture-blue.webp',
      images: ['https://media.fixture.invalid/fixture-detail.webp', 'https://blocked.fixture.invalid/not-approved.webp'],
    },
  });
  await insert('variants', {
    _id: id(110), product: id(4), sku: 'FIXTURE-INT-GRAPHITE', barcode: '9900000000110',
    attribute_values: { Color: 'Graphite' }, attributes: ['Color'],
    regular_price: 980, sale_price: 880, prices: { USD: { regular_price: 19, sale_price: 17 } },
    image: 'https://media.fixture.invalid/fixture-graphite.webp',
  });
  await insert('products', { ...domestic, _id: id(108), slug: 'fixture-unpublished', sku: 'FIXTURE-UNPUBLISHED', is_published: false });
  await insert('products', { ...domestic, _id: id(109), slug: 'fixture-pos-only', sku: 'FIXTURE-POS-ONLY', sale_channels: { website: false, pos: true } });
  console.log('Prepared Step 3 catalog cases in the local synthetic MongoDB fixture.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => client.close());
