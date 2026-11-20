import Link from "next/link";
import { notFound } from "next/navigation";
import { marketIds } from "@/config/markets";
import { ConnectedProductAuthoring } from "@/components/connected-product-authoring";
import { ConnectedProductCommerce } from "@/components/connected-product-commerce";
import { ConnectedProductLocalization } from "@/components/connected-product-localization";
import { ConnectedProductMedia } from "@/components/connected-product-media";
import { ConnectedProductPublication } from "@/components/connected-product-publication";
import { ProductEditor } from "@/components/product-editor";
import { TaxonomyPendingChanges } from "@/components/taxonomy-controls";
import { getDb } from "@/lib/db/client";
import { marketConfiguration } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { productionMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { catalogChoices, ownerProduct } from "@/lib/staff/catalog";
import { productIdField } from "@/lib/staff/catalog-input";
import { productMediaUploadAvailable } from "@/lib/staff/catalog-media-upload";
import { ownerProductFoundation } from "@/lib/staff/product-foundation";
import { productPublicationReadiness } from "@/lib/staff/product-publication";
import { productCategoryChoices, productWorkspaceHistory, productWorkspaceIdentity } from "@/lib/staff/product-workspace";
import "../../taxonomy/taxonomy.css";
import "../../product-workspace.css";

export const metadata = { title: "Product editor" };

const fullSections = [
  ["publication", "Publication"], ["general", "General"], ["categories", "Categories and attributes"],
  ["variants", "Options and variants"], ["compatibility", "Compatibility"], ["localization", "Localization"], ["media", "Media"],
  ["markets", "Markets and offers"], ["inventory", "Inventory"], ["history", "Change history"],
] as const;
const restrictedSections = [["markets", "Markets and offers"], ["inventory", "Inventory"]] as const;
const historicalSections = [["publication", "Publication"], ["variants", "Variants"], ["history", "Change history"]] as const;

export default async function ProductEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }, market] = await Promise.all([requireStaff(), params, currentMarket()]);
  if (productIdField.safeParse(id).data !== id) notFound();
  const workspace = await productWorkspaceIdentity(staff.id, id);
  if (!workspace) notFound();
  const { product, owner } = workspace;
  if (!product.foundation && owner) {
    const [existing, choices] = await Promise.all([ownerProduct(staff.id, id), catalogChoices(staff.id)]);
    if (!existing) notFound();
    return <>
      <div className="commerce-intro">
        <Link className="text-link" href="/staff/catalog">Product management</Link>
        <h1 className="display-type">Edit {product.name}</h1>
        <p>This listing uses the legacy catalog. Its SKU and saved market terms stay on the existing editor.</p>
      </div>
      <ProductEditor existing={existing} departments={choices.departments} collections={choices.collections} production={productionMode()} />
    </>;
  }
  const connected = owner ? await ownerProductFoundation(staff.id, id) : null;
  if (owner && !connected) notFound();
  const archived = product.publication === "ARCHIVED";
  const [categories, readiness, history] = connected ? await Promise.all([
    archived ? [] : productCategoryChoices(staff.id),
    productPublicationReadiness(getDb(), id),
    productWorkspaceHistory(staff.id, id, connected.variants.map(row => row.id)),
  ]) : [[], null, []] as const;
  const sections = connected ? archived ? historicalSections : fullSections : restrictedSections;
  const locales = [...new Set(marketIds.flatMap(marketId => marketConfiguration(marketId).languages))];
  const timestamps = new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

  return <TaxonomyPendingChanges>
    <div className="taxonomy-workspace connected-product-workspace">
      <header className="taxonomy-heading">
        <div><Link className="text-link" href="/staff/catalog">Product management</Link>
          <h1 className="display-type">{product.name}</h1>
          <p>{product.department.name} · {product.id}</p></div>
      </header>
      {!owner && <p className="taxonomy-muted">Shared content is view-only. Manage offers and stock within your commercial market grants.</p>}
      <div className="product-workspace-layout">
        <nav className="taxonomy-card product-workspace-links" aria-label="Product editor sections">
          <ul>{sections.map(([key, label]) => <li key={key}><a href={`#${key}`}>{label}</a></li>)}</ul>
        </nav>
        <div className="product-workspace-sections">
          {connected && <ConnectedProductPublication productId={id} revision={connected.revision}
            publication={connected.publication} readiness={readiness} />}
          {connected && !archived && <>
            <ConnectedProductAuthoring product={connected} categories={categories} marketId={market.id} />
            <ConnectedProductLocalization product={connected} localeChoices={locales} />
            <ConnectedProductMedia product={connected} uploadEnabled={productMediaUploadAvailable()} />
          </>}
          {connected && archived && <section id="variants" className="taxonomy-card">
            <h2>Variants</h2>
            {connected.variants.length ? <div className="taxonomy-scroll"><table className="taxonomy-table">
              <thead><tr><th scope="col">SKU</th><th scope="col">Options</th><th scope="col">Variant ID</th></tr></thead>
              <tbody>{connected.variants.map(row => <tr key={row.id}><th scope="row">{row.sku}</th><td>{row.label}</td><td>{row.id}</td></tr>)}</tbody>
            </table></div> : <p>No physical variants were recorded.</p>}
          </section>}
          {(!archived || !owner) && <ConnectedProductCommerce productId={id} actorKind="staff" />}
          {connected && <section id="history" className="taxonomy-card" aria-labelledby="product-history">
            <h2 id="product-history">Change history</h2>
            {history.length ? <div className="taxonomy-scroll"><table className="taxonomy-table product-workspace-history">
              <thead><tr><th scope="col">When (UTC)</th><th scope="col">Change</th><th scope="col">Actor</th></tr></thead>
              <tbody>{history.map(entry => <tr key={entry.id}>
                <td><time dateTime={entry.createdAt.toISOString()}>{timestamps.format(entry.createdAt)}</time></td>
                <td>{[entry.label, entry.market?.toUpperCase(), entry.locale, entry.publication, entry.fields].filter(Boolean).join(" · ")}</td>
                <td>{entry.actorName}</td>
              </tr>)}</tbody>
            </table></div> : <p>No material changes have been recorded.</p>}
          </section>}
        </div>
      </div>
    </div>
  </TaxonomyPendingChanges>;
}
