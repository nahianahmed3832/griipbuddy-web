import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { getDb } from "@/lib/db/client";
import { readQuery, type SearchParams } from "@/lib/catalog/listing";
import { CreateList } from "@/components/marketplace/favorites";
import { ListLinks } from "@/components/marketplace/lists";
import { SignInGate } from "@/components/marketplace/session";

export const metadata = { title: "Gift registry" };

export default async function RegistryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!marketplaceMode()) notFound();
  const [shopper, params] = await Promise.all([getShopper(), searchParams]);
  const query = readQuery(params);
  const select = { id: true, name: true, registry: true, public: true } as const;
  const [mine, found] = await Promise.all([
    shopper ? getDb().shopperList.findMany({ where: { registry: true, shopperId: shopper.id }, select, take: 50 }) : [],
    query ? getDb().shopperList.findMany({ where: { registry: true, public: true, name: { contains: query, mode: "insensitive" } }, select, take: 25 }) : [],
  ]);
  return <div className="shell mp-page">
    <section className="mp-registry-hero"><h1 className="mp-page-title">GriipBuddy Gift Registry</h1>
      <p>Make a list for your next occasion and share it with your guests.</p>
      <Form className="mp-inline" action="/registry"><label className="store-dialog__field">Find a registry by name<input name="q" type="search" defaultValue={query} minLength={2} maxLength={120} required/></label>
        <button className="button button--primary">Find a registry</button></Form>
    </section>
    {query && <section className="mp-section"><h2>Search results</h2>{found.length ? <ListLinks lists={found}/> : <p>No public registries match this name.</p>}</section>}
    <section className="mp-section"><h2>Your registries</h2>
      {shopper ? <><ListLinks lists={mine}/><CreateList registry/></> : <SignInGate>Sign in to create a registry.</SignInGate>}
    </section>
    <Link className="button button--outline" href="/gifts">Browse gift ideas</Link>
  </div>;
}
