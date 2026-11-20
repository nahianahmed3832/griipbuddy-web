"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { departmentFamily } from "@/lib/catalog/departments";
import type { readCategoryImpact } from "@/lib/staff/taxonomy-impact";
import { CatalogImageField } from "./catalog-image-field";
import { runCatalogCommand, TaxonomyFeedback, TaxonomyForm, useConfirmTaxonomyNavigation, useTaxonomyOperation } from "./taxonomy-controls";

type Kind = "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY";
type State = "DRAFT" | "ACTIVE" | "ARCHIVED";
type Media = { src: string; alt: string };
export type TaxonomyEditorChoice = {
  id: string; name: string; slug: string; kind: Kind | null; parentId: string | null; state: State; position: number; revision: number;
  visibleInNavigation?: boolean;
};
type CategoryTranslation = { locale: string; name: string; shortName: string; description: string; slug: string | null };
type MarketPresentation = {
  marketId: MarketId; visibleInNavigation: boolean | null; position: number | null; imageSrc: string | null; imageAlt: string | null;
};
export type TaxonomyEditorCategory = TaxonomyEditorChoice & {
  shortName: string; description: string; imageSrc: string; imageAlt: string; bannerSrc: string | null; bannerAlt: string | null;
  seoTitle: string | null; seoDescription: string | null; translations: CategoryTranslation[]; marketPresentations: MarketPresentation[];
  aliases?: { locale: string; slug: string }[];
};
type EditorProps = {
  category: TaxonomyEditorCategory | null;
  categories: readonly TaxonomyEditorChoice[];
  canManageShared: boolean;
  canManageMarket?: boolean;
  markets: readonly { id: MarketId; name: string }[];
  selectedMarket: MarketId;
  languages: readonly string[];
};
type Operation = ReturnType<typeof useTaxonomyOperation>;
type CategoryImpact = Awaited<ReturnType<typeof readCategoryImpact>>;
type TypedCategory = TaxonomyEditorCategory & { kind: Kind };

const kinds: Record<Kind, string> = { DEPARTMENT: "Department", CATEGORY: "Category", SUBCATEGORY: "Subcategory" };
const parentKind = { DEPARTMENT: null, CATEGORY: "DEPARTMENT", SUBCATEGORY: "CATEGORY" } as const;

const input = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function imageInput(form: FormData, name: string): Media | null {
  const src = input(form, `${name}.src`);
  const alt = input(form, `${name}.alt`);
  return src || alt ? { src, alt } : null;
}

function savedCategoryFields(category: TypedCategory) {
  const { id, revision, slug, name, shortName, description, kind, parentId, position, state, imageSrc, imageAlt } = category;
  return { id, revision, slug, name, shortName, description, kind, parentId, position, state, image: { src: imageSrc, alt: imageAlt } };
}

function Save({ operation, children }: { operation: Operation; children: string }) {
  return <button type="submit" className="button button--primary" disabled={operation.pending}>
    {operation.pending ? "Saving…" : children}
  </button>;
}

function parentChoices(categories: readonly TaxonomyEditorChoice[], kind: Kind, id?: string, active = false) {
  const excluded = id ? departmentFamily(categories, id) : new Set<string>();
  return categories.filter(category => category.kind === parentKind[kind] && category.state !== "ARCHIVED" &&
    (!active || category.state === "ACTIVE") && !excluded.has(category.id));
}

function ParentField({ kind, categories, parentId, name = "parentId" }: {
  kind: Kind; categories: readonly TaxonomyEditorChoice[]; parentId?: string | null; name?: string;
}) {
  if (kind === "DEPARTMENT") return <p className="taxonomy-muted">Departments sit at the top of the category tree.</p>;
  return <label>Parent category
    <select key={kind} name={name} defaultValue={parentId ?? ""} required>
      <option value="">Choose a {kinds[parentKind[kind]].toLowerCase()}</option>
      {categories.map(parent => <option key={parent.id} value={parent.id}>{parent.name} ({parent.id})</option>)}
    </select>
  </label>;
}

function CategoryNames({ category }: { category?: TypedCategory }) {
  return <>
    <div className="taxonomy-fields">
      <label>Name<input name="name" required minLength={2} maxLength={100} defaultValue={category?.name} /></label>
      <label>Navigation label<input name="shortName" required minLength={2} maxLength={32} defaultValue={category?.shortName} /></label>
    </div>
    <label>Description<textarea name="description" rows={4} maxLength={1200} defaultValue={category?.description} /></label>
  </>;
}

function CategoryStatus({ category }: { category?: TypedCategory }) {
  return <label>Status<select name="state" defaultValue={category?.state ?? "DRAFT"}>
    <option value="DRAFT">Draft</option><option value="ACTIVE">Active</option>
  </select></label>;
}

function CreateCategory({ categories }: Pick<EditorProps, "categories">) {
  const [kind, setKind] = useState<Kind>("DEPARTMENT");
  const operation = useTaxonomyOperation();
  const router = useRouter();
  async function save(event: FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const id = input(form, "id");
    const saved = await operation.run(() => runCatalogCommand("category.save", {
      id, kind, revision: null, name: input(form, "name"), shortName: input(form, "shortName"), description: input(form, "description"),
      slug: input(form, "slug"), parentId: input(form, "parentId") || null, state: input(form, "state"),
      position: Number(input(form, "position")), image: imageInput(form, "image"),
    }), "Category created.", { refresh: false });
    if (saved) router.replace(`/staff/catalog/taxonomy?category=${encodeURIComponent(id)}`);
    return saved;
  }

  return <section className="taxonomy-card">
    <h2>Create a category</h2>
    <p className="taxonomy-muted">Choose a level and a stable ID. You can add translations, a banner and search details after saving.</p>
    <TaxonomyForm onSubmit={save}>
      <div className="taxonomy-fields">
        <label>Level<select value={kind} onChange={event => setKind(event.currentTarget.value as Kind)}>
          {Object.entries(kinds).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        <ParentField kind={kind} categories={parentChoices(categories, kind)} />
        <label>Stable ID<input name="id" pattern="[a-z0-9][a-z0-9-]{0,79}" required maxLength={80} /></label>
        <label>URL slug<input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" required maxLength={120} /></label>
      </div>
      <CategoryNames />
      <div className="taxonomy-fields">
        <CategoryStatus />
        <label>Position<input name="position" type="number" min={0} max={9999} defaultValue={100} required /></label>
      </div>
      <CatalogImageField name="image" label="Category image" required />
      <div className="taxonomy-actions"><Save operation={operation}>Create category</Save></div>
      <TaxonomyFeedback {...operation} />
    </TaxonomyForm>
  </section>;
}

function GeneralEditor({ category, parentName }: { category: TypedCategory; parentName?: string }) {
  const operation = useTaxonomyOperation();
  return <section className="taxonomy-card">
    <h2>General</h2>
    <p className="taxonomy-muted">{kinds[category.kind]} · {category.id} · {parentName ? `Under ${parentName}` : "Top level"}</p>
    <TaxonomyForm onSubmit={event => {
      const form = new FormData(event.currentTarget);
      return operation.run(() => runCatalogCommand("category.save", { ...savedCategoryFields(category),
        name: input(form, "name"), shortName: input(form, "shortName"), description: input(form, "description"),
        state: input(form, "state"),
      }), "General details saved.");
    }}>
      <CategoryNames category={category} />
      <CategoryStatus category={category} />
      <p className="taxonomy-muted">Use Move or archive to review assignments before changing this category’s placement.</p>
      <div className="taxonomy-actions"><Save operation={operation}>Save general details</Save></div>
      <TaxonomyFeedback {...operation} />
    </TaxonomyForm>
  </section>;
}

function LocaleForm({ category, locale, onDirty }: { category: TypedCategory; locale: string; onDirty: (dirty: boolean) => void }) {
  const operation = useTaxonomyOperation();
  const translation = category.translations.find(item => item.locale === locale);
  const [values, setValues] = useState(() => ({
    name: translation?.name ?? category.name, shortName: translation?.shortName ?? category.shortName,
    description: translation?.description ?? category.description, slug: translation?.slug ?? "",
  }));

  async function save(event: FormEvent<HTMLFormElement>) {
    const removed = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === "remove";
    if (removed && !window.confirm(`Remove the ${locale} translation and inherit the default content?`)) return false;
    const success = await operation.run(() => runCatalogCommand("category.translation", {
      id: category.id, revision: category.revision, locale, translation: removed ? null : { ...values, slug: values.slug || null },
    }), removed ? "Translation removed. Default content is in use." : "Translation saved.");
    if (success) {
      if (removed) setValues({ name: category.name, shortName: category.shortName, description: category.description, slug: "" });
      onDirty(false);
    }
    return success;
  }

  return <TaxonomyForm onSubmit={save} onChange={() => onDirty(true)}>
    <p className="taxonomy-muted">{translation ? `Editing the explicit ${locale} translation.` : `${locale} inherits the default name and description until a translation is saved.`}</p>
    <div className="taxonomy-fields">
      <label>Translated name<input name="name" required minLength={2} maxLength={100} value={values.name}
        onChange={event => setValues({ ...values, name: event.target.value })} /></label>
      <label>Translated navigation label<input name="shortName" required minLength={2} maxLength={32} value={values.shortName}
        onChange={event => setValues({ ...values, shortName: event.target.value })} /></label>
      <label>Translated URL slug<input name="slug" maxLength={120} placeholder={category.slug} value={values.slug}
        onChange={event => setValues({ ...values, slug: event.target.value })} /></label>
    </div>
    <label>Translated description<textarea name="description" rows={4} maxLength={1200} value={values.description}
      onChange={event => setValues({ ...values, description: event.target.value })} /></label>
    <p className="taxonomy-muted">Leave the translated slug blank to use {category.slug}. Renaming a slug keeps its redirect.</p>
    <div className="taxonomy-actions">
      <Save operation={operation}>Save translation</Save>
      {translation && <button type="submit" value="remove" formNoValidate className="button button--outline" disabled={operation.pending}>
        Remove translation
      </button>}
    </div>
    <TaxonomyFeedback {...operation} />
  </TaxonomyForm>;
}

function LocalizationEditor({ category, languages }: { category: TypedCategory; languages: readonly string[] }) {
  const options = [...new Set([...languages, ...category.translations.map(translation => translation.locale)])];
  const [locale, setLocale] = useState(options[0] ?? "en");
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const suggestions = useId();

  function changeLocale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requested = input(new FormData(event.currentTarget), "locale");
    try {
      const [valid] = Intl.getCanonicalLocales(requested);
      if (!valid) throw new Error();
      if (valid === locale) {
        setError("");
        return;
      }
      if (dirty.current && !window.confirm("Discard the unsaved translation before switching locales?")) return;
      dirty.current = false;
      setError("");
      setLocale(valid);
    } catch {
      setError("Enter a valid locale tag, such as en-US or bn-BD.");
    }
  }
  return <section className="taxonomy-card">
    <h2>Localization</h2>
    <form className="taxonomy-form commerce-form" onSubmit={changeLocale}>
      <div className="taxonomy-fields">
        <label>Locale tag<input name="locale" list={suggestions} defaultValue={locale} maxLength={35} required /></label>
        <datalist id={suggestions}>{options.map(option => <option key={option} value={option} />)}</datalist>
        <div className="taxonomy-actions"><button className="button button--outline" type="submit">Edit locale</button></div>
      </div>
    </form>
    {error && <p role="alert" className="taxonomy-error">{error}</p>}
    <LocaleForm key={locale} category={category} locale={locale} onDirty={value => { dirty.current = value; }} />
  </section>;
}

function MediaEditor({ category }: { category: TypedCategory }) {
  const operation = useTaxonomyOperation();
  const path = category.bannerSrc ?? category.imageSrc;
  const alt = category.bannerAlt ?? category.imageAlt;
  return <section className="taxonomy-card">
    <h2>Media</h2>
    <Image src={storefrontPath(path)} alt={alt} unoptimized width={320} height={120} className="taxonomy-category-thumbnail" />
    <p className="taxonomy-muted">Category images represent the category in browsing. A banner is optional and requires its own descriptive alternative text.</p>
    <TaxonomyForm onSubmit={event => {
      const form = new FormData(event.currentTarget);
      return operation.run(() => runCatalogCommand("category.save", { ...savedCategoryFields(category),
        image: imageInput(form, "image"), banner: imageInput(form, "banner"),
      }), "Category media saved.");
    }}>
      <CatalogImageField name="image" src={category.imageSrc} alt={category.imageAlt} label="Category image" required />
      <CatalogImageField name="banner" src={category.bannerSrc ?? undefined} alt={category.bannerAlt ?? undefined} label="Banner image" />
      <div className="taxonomy-actions"><Save operation={operation}>Save media</Save></div>
      <TaxonomyFeedback {...operation} />
    </TaxonomyForm>
  </section>;
}

function SeoEditor({ category }: { category: TypedCategory }) {
  const operation = useTaxonomyOperation();
  return <section className="taxonomy-card">
    <h2>SEO and URLs</h2>
    <p className="taxonomy-muted">Current URL <code>/departments/{category.slug}</code>. The stable category ID stays the same when this URL changes.</p>
    <TaxonomyForm onSubmit={event => {
      const form = new FormData(event.currentTarget);
      return operation.run(() => runCatalogCommand("category.save", { ...savedCategoryFields(category), slug: input(form, "slug"),
        seoTitle: input(form, "seoTitle") || null, seoDescription: input(form, "seoDescription") || null,
      }), "Search details saved.");
    }}>
      <label>Canonical URL slug<input name="slug" defaultValue={category.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={120} required /></label>
      <label>Page title<input name="seoTitle" defaultValue={category.seoTitle ?? ""} placeholder={category.name} maxLength={120} /></label>
      <label>Search description<textarea name="seoDescription" defaultValue={category.seoDescription ?? ""} placeholder={category.description}
        rows={3} maxLength={320} /></label>
      <p className="taxonomy-muted">Empty title and description fields inherit the localized category content.</p>
      <div className="taxonomy-actions"><Save operation={operation}>Save SEO and URL</Save></div>
      <TaxonomyFeedback {...operation} />
    </TaxonomyForm>
    {!!category.aliases?.length && <details>
      <summary>Previous URLs ({category.aliases.length})</summary>
      <ul>{category.aliases.map(alias => <li key={`${alias.locale}:${alias.slug}`}>
        <code>/departments/{alias.slug}</code>{alias.locale && ` · ${alias.locale}`}
      </li>)}</ul>
    </details>}
  </section>;
}

function MarketEditor({ category, marketId, marketName, canEdit, canUpload, parentHidden }: {
  category: TaxonomyEditorCategory; marketId: MarketId; marketName: string; canEdit: boolean; canUpload: boolean; parentHidden: boolean;
}) {
  const operation = useTaxonomyOperation();
  const override = category.marketPresentations.find(item => item.marketId === marketId);

  async function save(event: FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const choice = input(form, "visibility");
    const placement = input(form, "marketPosition");
    const image = imageInput(form, "marketImage");
    const presentation = { ...(choice && { visibleInNavigation: choice === "show" }),
      ...(placement && { position: Number(placement) }), ...(image && { image }) };
    return operation.run(() => runCatalogCommand("category.presentation", {
      id: category.id, revision: category.revision, marketId, presentation: Object.keys(presentation).length ? presentation : null,
    }), "Market presentation saved.");
  }

  return <section className="taxonomy-card">
    <h2>Market presentation</h2>
    <p className="taxonomy-muted">{marketName} · {override ? "With overrides" : "Inherits category defaults"}</p>
    {parentHidden && <p className="taxonomy-muted">A parent category currently hides this branch from navigation.</p>}
    <p className="taxonomy-muted">Menu visibility applies only to navigation. Product sales use their market offers.</p>
    {canEdit ? <TaxonomyForm onSubmit={save}>
      <div className="taxonomy-fields">
        <label>Navigation visibility<select name="visibility" defaultValue={override?.visibleInNavigation == null ? ""
          : override.visibleInNavigation ? "show" : "hide"}>
          <option value="">Inherit</option><option value="show">Show when ancestors allow</option><option value="hide">Hide from navigation</option>
        </select></label>
        <label>Market display order<input name="marketPosition" type="number" min={0} max={9999} placeholder={String(category.position)}
          defaultValue={override?.position ?? ""} /></label>
      </div>
      <CatalogImageField name="marketImage" label="Market image" src={override?.imageSrc ?? undefined} alt={override?.imageAlt ?? undefined}
        allowUpload={canUpload} />
      <p className="taxonomy-muted">A blank market order or image uses the shared category setting.
        {!canUpload && " Choose an image already available in this market."}</p>
      <div className="taxonomy-actions"><Save operation={operation}>Save market presentation</Save></div>
      <TaxonomyFeedback {...operation} />
    </TaxonomyForm> : <p className="taxonomy-muted">You can view this market. Merchandising access is required to save changes.</p>}
  </section>;
}

function StructureEditor({ category, categories }: { category: TypedCategory; categories: readonly TaxonomyEditorChoice[] }) {
  const operation = useTaxonomyOperation();
  const preview = useTaxonomyOperation();
  const confirmNavigation = useConfirmTaxonomyNavigation();
  const [impact, setImpact] = useState<CategoryImpact | null>(null);
  const [moveParent, setMoveParent] = useState("");
  const validPreview = impact?.revision === category.revision ? impact : null;
  const candidates = parentChoices(categories, category.kind, category.id, category.state === "ACTIVE")
    .filter(choice => choice.id !== category.parentId);

  async function review() {
    await preview.run(async () => {
      const response = await fetch(storefrontPath(`/api/staff/catalog/category-impact?categoryId=${encodeURIComponent(category.id)}`), { cache: "no-store" });
      const body = await response.json().catch(() => null) as { data?: CategoryImpact; error?: { message?: string } } | null;
      if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? "The impact preview could not be loaded.");
      setImpact(body.data);
    }, "", { refresh: false });
  }
  async function move(event: FormEvent<HTMLFormElement>) {
    if (!validPreview) return false;
    const parentId = input(new FormData(event.currentTarget), "parentId");
    const success = await operation.run(() => runCatalogCommand("category.move", {
      id: category.id, revision: category.revision, parentId,
    }), "Category moved. Its product assignments were preserved.");
    if (success) {
      setImpact(null);
      setMoveParent("");
    }
    return success;
  }

  async function archive() {
    if (!validPreview?.canArchive || !confirmNavigation() || !window.confirm(`Archive ${category.name} and hide it from browsing?`)) return;
    const success = await operation.run(() => runCatalogCommand("category.archive", {
      id: category.id, revision: category.revision,
    }), "Category archived.");
    if (success) setImpact(null);
  }

  return <section className="taxonomy-card">
    <h2>Move or archive</h2>
    <p className="taxonomy-muted">Moving this category keeps its ID, URLs, and product assignments. Review the branch before making a change.</p>
    <div className="taxonomy-actions">
      <button className="button button--outline" type="button" disabled={preview.pending || operation.pending} onClick={() => void review()}>
        {preview.pending ? "Loading impact…" : "Review category impact"}
      </button>
    </div>
    <TaxonomyFeedback {...preview} />
    {validPreview && <div role="status">
      <p>{validPreview.primary} primary product assignments, {validPreview.additional} additional assignments, and {validPreview.descendantProducts} products assigned only in descendants.</p>
      <p>{validPreview.childCategories} descendant categories and {validPreview.menuLinks} direct menu references.</p>
      <p>{validPreview.canArchive ? "Archiving will hide this category from browsing and navigation while retaining its records."
        : `Archive blocked by ${validPreview.activeDirect} directly assigned published products and ${validPreview.activeChildren} active child categories.`}</p>
    </div>}
    {category.kind !== "DEPARTMENT" && <TaxonomyForm onSubmit={move}>
      <label>New parent category<select name="parentId" value={moveParent} onChange={event => setMoveParent(event.target.value)} required>
        <option value="">Choose a parent</option>
        {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.id})</option>)}
      </select></label>
      {candidates.length === 0 && <p className="taxonomy-muted">No other parent of the correct level is available.</p>}
      <div className="taxonomy-actions"><button type="submit" className="button button--outline" disabled={!validPreview || !moveParent || operation.pending}>
        {operation.pending ? "Saving…" : "Move category"}
      </button></div>
    </TaxonomyForm>}
    <div className="taxonomy-actions">
      <button type="button" className="button button--outline" disabled={!validPreview?.canArchive || operation.pending}
        onClick={() => void archive()}>Archive category</button>
    </div>
    <TaxonomyFeedback {...operation} />
  </section>;
}

export function TaxonomyCategoryEditor({ category, categories, canManageShared, canManageMarket = canManageShared,
  markets, selectedMarket, languages }: EditorProps) {
  if (!category) return canManageShared ? <CreateCategory categories={categories} /> :
    <section className="taxonomy-card"><h2>Choose a category</h2><p>Central owner access is required to create categories.</p></section>;
  const marketName = markets.find(market => market.id === selectedMarket)?.name ?? selectedMarket.toUpperCase();
  if (!category.kind || category.state === "ARCHIVED") return <section className="taxonomy-card">
    <h2>{category.name}</h2>
    <p className="taxonomy-muted">{category.id} · {category.state === "ARCHIVED" ? "Archived" : "Legacy classification"}</p>
    <p>{category.state === "ARCHIVED" ? "This category is retained for existing references." : "This record uses the legacy taxonomy."}</p>
    {!category.kind && canManageShared && <Link className="text-link" href={`/staff/catalog/taxonomy/legacy?category=${encodeURIComponent(category.id)}`}>Edit this legacy category</Link>}
  </section>;
  const typed: TypedCategory = { ...category, kind: category.kind };
  const parent = categories.find(choice => choice.id === category.parentId);
  return <div className="taxonomy-editor-sections">
    {canManageShared ? <>
      <GeneralEditor category={typed} parentName={parent?.name} />
      <LocalizationEditor category={typed} languages={languages} />
      <MediaEditor category={typed} />
      <SeoEditor category={typed} />
      <StructureEditor category={typed} categories={categories} />
    </> : <section className="taxonomy-card">
      <h2>{category.name}</h2>
      <p>{category.description}</p>
      <p className="taxonomy-muted">The shared name, parent, localization and SEO are managed by central owners.</p>
    </section>}
    <MarketEditor key={selectedMarket} category={category} marketId={selectedMarket} marketName={marketName} parentHidden={parent?.visibleInNavigation === false}
      canEdit={canManageMarket} canUpload={canManageShared} />
  </div>;
}
