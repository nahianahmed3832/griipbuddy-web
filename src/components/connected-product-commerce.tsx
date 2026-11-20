import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { getStaff } from "@/lib/staff/access";
import { readProductWorkspaceCommerce } from "@/lib/staff/product-workspace-commerce";
import { ConnectedInventory, ConnectedMarketSelector, ConnectedOffers } from "./product-commerce-tools";

export async function ConnectedProductCommerce({ productId, actorKind }: { productId: string; actorKind: "staff" | "seller" }) {
  const [viewer, market] = await Promise.all([actorKind === "staff" ? getStaff() : getShopper(), currentMarket()]);
  const workspace = viewer && await readProductWorkspaceCommerce({ kind: actorKind, id: viewer.id }, productId, market.id);
  const data = workspace && workspace.data;
  return <>
    <section className="commerce-panel taxonomy-card" aria-labelledby="product-offers-heading" id="markets">
      <div className="taxonomy-card-heading">
        <div><h2 id="product-offers-heading">Markets and offers</h2>
          <p className="commerce-muted">Local prices and selling terms for each physical variant.</p></div>
        {workspace && workspace.marketOptions.length > 0 && <ConnectedMarketSelector actorKind={actorKind}
          markets={workspace.marketOptions} selected={data ? market.id : undefined} />}
      </div>
      {data ? <ConnectedOffers key={data.market.id} data={data} /> : <p>
        {workspace && workspace.marketOptions.length ? "Choose an approved market for this product." : "No approved markets are available for these offers."}
      </p>}
    </section>
    <section className="commerce-panel taxonomy-card" aria-labelledby="product-stock-heading" id="inventory">
      <h2 id="product-stock-heading">Inventory</h2>
      {data ? <ConnectedInventory key={data.market.id} data={data} /> : <p>Choose an approved market to access inventory.</p>}
    </section>
  </>;
}
