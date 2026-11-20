"use client";

import { useActionState, useState } from "react";
import { sectionTypes, type HomepageContentData, type HomepageSection } from "@/lib/catalog/homepage-contract";
import { publishHomepageAction, saveHomepageAction, saveMarketGrantAction } from "@/app/staff/homepage-actions";

const labels: Record<Exclude<HomepageSection["type"], "TILES" | "BENEFITS">, string> = {
  BANNER: "Banner", CURATED: "Curated products", COLLECTION: "Collection", BESTSELLERS: "Market bestsellers",
  TRENDING: "Market trending", RECENTLY_VIEWED: "Recently viewed", RELATED: "Similar products",
  DEPARTMENTS: "Department links", COLLECTIONS: "Collection links", NEW: "New arrivals", FEATURED: "Featured products", DEALS: "Active offers",
  CATEGORY_SPOTLIGHT: "Category spotlight",
};
const keys = (value: string) => value.trim().split(/[\s,]+/).filter(Boolean);
type Message = { error?: string; success?: string };

function Status({ message }: { message: Message | null }) {
  return message?.error ? <p role="alert">{message.error}</p> : <p role="status">{message?.success}</p>;
}

export function HomepageEditor({ scope, revision, initial }: { scope: string; revision: number; initial: HomepageContentData }) {
  const [sections, setSections] = useState(initial.sections.map((section, index) => ({
    section, editorId: `section-${index}`, products: section.productIds?.join(", ") ?? "", fallbacks: section.fallbackIds?.join(", ") ?? "",
  })));
  const [hidden, setHidden] = useState(initial.hiddenSections.join(", "));
  const [message, action, waiting] = useActionState(saveHomepageAction.bind(null, scope, revision), null);

  if (initial.sections.some(section => section.type === "TILES" || section.type === "BENEFITS")) {
    return <p>Manage this draft and its merchandising and service tiles in the main GriipBuddy admin.</p>;
  }

  function edit(editorId: string, fields: Partial<HomepageSection>) {
    setSections(rows => rows.map(row => row.editorId === editorId ? { ...row, section: { ...row.section, ...fields } } : row));
  }
  function add() {
    const id = Math.random().toString(36).slice(2, 10);
    setSections(rows => [...rows, { editorId: id, products: "", fallbacks: "",
      section: { key: `section-${id}`, type: "BANNER", title: "", position: rows.length + 1 } }]);
  }
  const payload = { hiddenSections: keys(hidden), sections: sections.map(({ section, products, fallbacks }) => ({
    ...section, productIds: keys(products), fallbackIds: keys(fallbacks),
    link: section.link?.label || section.link?.href ? section.link : undefined,
    bannerImage: section.bannerImage?.src ? section.bannerImage : undefined,
  })) };

  return <form action={action} className="staff-form homepage-draft-form">
    <input type="hidden" name="content" value={JSON.stringify(payload)} />
    <label>Hide inherited section keys
      <input value={hidden} maxLength={620} onChange={event => setHidden(event.target.value)} placeholder="For example: hero, trending" />
    </label>
    {sections.map(({ editorId, section, products, fallbacks }, index) => <fieldset className="staff-expression homepage-editor-section" key={editorId}>
      <legend>{section.title || `Section ${index + 1}`}</legend>
      <div className="homepage-editor-fields">
        <label>Section key<input required maxLength={39} value={section.key} onChange={event => edit(editorId, { key: event.target.value })} /></label>
        <label>Component<select value={section.type} onChange={event => edit(editorId, { type: event.target.value as HomepageSection["type"],
          categoryId: undefined, categoryIds: undefined, collectionIds: undefined, budget: undefined })}>
          {sectionTypes.filter(type => type !== "TILES" && type !== "BENEFITS")
            .filter(type => type !== "CATEGORY_SPOTLIGHT" || section.type === type)
            .map(type => <option key={type} value={type}>{labels[type]}</option>)}
        </select></label>
        <label>Position<input type="number" min="1" max="100" required value={section.position || ""} onChange={event => edit(editorId, { position: Number(event.target.value) })} /></label>
        <label>Title<input required maxLength={90} value={section.title} onChange={event => edit(editorId, { title: event.target.value })} /></label>
        <label className="homepage-editor-wide">Description
          <textarea maxLength={300} rows={2} value={section.description ?? ""} onChange={event => edit(editorId, { description: event.target.value || undefined })} />
        </label>
        {["CURATED", "BANNER"].includes(section.type) && <label>Catalog product IDs
          <input value={products} onChange={event => setSections(rows => rows.map(row =>
            row.editorId === editorId ? { ...row, products: event.target.value } : row))} />
        </label>}
        {section.type === "BANNER" && <>
          <label>Banner image path<input value={section.bannerImage?.src ?? ""} maxLength={140} placeholder="/editorial/hero.webp"
            onChange={event => edit(editorId, { bannerImage: { src: event.target.value, alt: section.bannerImage?.alt ?? "" } })} /></label>
          <label>Banner image alt text<input value={section.bannerImage?.alt ?? ""} maxLength={130}
            onChange={event => edit(editorId, { bannerImage: { src: section.bannerImage?.src ?? "", alt: event.target.value } })} /></label>
        </>}
        {section.type === "COLLECTION" && <label>Collection slug
          <input required value={section.collection ?? ""} onChange={event => edit(editorId, { collection: event.target.value || undefined })} />
        </label>}
        {["BESTSELLERS", "TRENDING"].includes(section.type) && <label>Fallback product IDs
          <input value={fallbacks} onChange={event => setSections(rows => rows.map(row =>
            row.editorId === editorId ? { ...row, fallbacks: event.target.value } : row))} />
        </label>}
        <label>Maximum products<input type="number" min="1" max="12" value={section.limit ?? ""} onChange={event => edit(editorId, { limit: event.target.value ? Number(event.target.value) : undefined })} /></label>
        <label>Starts in market local time<input type="datetime-local" value={section.startsLocal ?? ""} onChange={event => edit(editorId, { startsLocal: event.target.value || undefined })} /></label>
        <label>Ends in market local time<input type="datetime-local" value={section.endsLocal ?? ""} onChange={event => edit(editorId, { endsLocal: event.target.value || undefined })} /></label>
        <label>Link text<input value={section.link?.label ?? ""} maxLength={40} onChange={event => edit(editorId, { link: { label: event.target.value, href: section.link?.href ?? "" } })} /></label>
        <label>Store link<input value={section.link?.href ?? ""} placeholder="/shop" maxLength={180} onChange={event => edit(editorId, { link: { label: section.link?.label ?? "", href: event.target.value } })} /></label>
      </div>
      <button type="button" className="button button--outline" onClick={() => setSections(rows => rows.filter(row => row.editorId !== editorId))}>Remove from this draft</button>
    </fieldset>)}
    <div className="homepage-editor-actions">
      <button type="button" className="button button--outline" disabled={sections.length === 16} onClick={add}>Add section</button>
      <button type="submit" className="button button--primary" disabled={waiting}>Save draft</button>
    </div>
    <Status message={message} />
  </form>;
}

export function PublishHomepage({ scope, revision, restore }: { scope: string; revision: number; restore?: string }) {
  const [message, action, waiting] = useActionState(publishHomepageAction.bind(null, scope, revision), null);
  return <form action={action}>
    {restore && <input type="hidden" name="release" value={restore} />}
    <button type="submit" className={`button ${restore ? "button--outline" : "button--primary"}`} disabled={waiting}>
      {restore ? "Restore version" : "Publish saved draft"}
    </button>
    <Status message={message} />
  </form>;
}

export function MarketGrantForm({ users, markets }: { users: { id: string; name: string }[]; markets: { id: string; name: string }[] }) {
  const [message, action, waiting] = useActionState(saveMarketGrantAction, null);
  return <form action={action} className="staff-form homepage-draft-form">
    <div className="homepage-editor-fields">
      <label>Staff account<select name="user" required>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
      <label>Market<select name="market" required>{markets.map(market => <option key={market.id} value={market.id}>{market.name}</option>)}</select></label>
      <label><input type="checkbox" name="merchandising" /> Homepage editing</label>
      <label><input type="checkbox" name="reporting" /> Reporting access</label>
    </div>
    <button className="button button--primary" disabled={waiting || !users.length}>Save market access</button>
    <Status message={message} />
  </form>;
}
