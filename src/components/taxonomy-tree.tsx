"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Plus, Search } from "lucide-react";
import { departmentAncestorPath, departmentTree } from "@/lib/catalog/departments";
import { runCatalogCommand, TaxonomyFeedback, useConfirmTaxonomyNavigation, useTaxonomyOperation } from "./taxonomy-controls";

export type TaxonomyNode = {
  id: string;
  name: string;
  slug: string;
  kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY" | null;
  parentId: string | null;
  state: "DRAFT" | "ACTIVE" | "ARCHIVED";
  position: number;
  revision: number;
  visibleInNavigation: boolean;
};

type TreeNode = TaxonomyNode & { children: TreeNode[] };
const label = (kind: TaxonomyNode["kind"]) => kind === "DEPARTMENT" ? "Department" : kind === "CATEGORY" ? "Category" : kind === "SUBCATEGORY" ? "Subcategory" : "Legacy";
const status = (node: TaxonomyNode) => node.state === "ACTIVE" ? "Active" : node.state === "DRAFT" ? "Draft" : "Archived";
const filterKey = (value: string) => value.normalize("NFKC").toLowerCase();

function TreeBranch({ nodes, selected }: { nodes: readonly TreeNode[]; selected?: string }) {
  return <ul className="taxonomy-branch">
    {nodes.map(node => <li key={node.id}>
      <Link href={`/staff/catalog/taxonomy?category=${encodeURIComponent(node.id)}`}
        aria-current={selected === node.id ? "page" : undefined} prefetch={false}>
        <ChevronRight size={13} aria-hidden="true" />
        <span className="taxonomy-node-label"><strong>{node.name}</strong><small>{label(node.kind)}</small></span>
        <span className="taxonomy-badge" data-state={node.state.toLowerCase()}>{status(node)}</span>
        {!node.visibleInNavigation && <span className="taxonomy-badge" title="Hidden from navigation in this market">Hidden</span>}
      </Link>
      {!!node.children.length && <TreeBranch nodes={node.children} selected={selected} />}
    </li>)}
  </ul>;
}

export function TaxonomyTree({ categories, selected, canManage }: {
  categories: TaxonomyNode[]; selected?: string; canManage: boolean;
}) {
  const [search, setSearch] = useState("");
  const operation = useTaxonomyOperation();
  const confirm = useConfirmTaxonomyNavigation();
  const current = categories.find(category => category.id === selected);
  const siblings = current ? categories.filter(row => row.parentId === current.parentId && row.kind && row.state !== "ARCHIVED")
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id, "en")) : [];
  const index = siblings.findIndex(row => row.id === selected);
  const tree = useMemo(() => {
    const term = filterKey(search.trim());
    if (!term) return departmentTree(categories);
    const nodes = new Map(categories.map(category => [category.id, category]));
    const visible = new Set(categories.filter(category => filterKey(`${category.name} ${category.slug}`).includes(term))
      .flatMap(category => departmentAncestorPath(nodes, category.id)?.map(ancestor => ancestor.id) ?? []));
    return departmentTree(categories.filter(category => visible.has(category.id)));
  }, [categories, search]);

  async function reorder(direction: -1 | 1) {
    const destination = index + direction;
    if (!canManage || index < 0 || destination < 0 || destination >= siblings.length || !confirm()) return;
    const ordered = [...siblings];
    [ordered[index], ordered[destination]] = [ordered[destination], ordered[index]];
    await operation.run(() => runCatalogCommand("category.reorder", {
      parentId: current?.parentId ?? null, siblings: ordered.map(({ id, revision }) => ({ id, revision })),
    }), "Category order saved.");
  }

  return <aside className="taxonomy-card taxonomy-sidebar" aria-label="Category tree">
    <div className="taxonomy-card-heading">
      <h2>Category tree</h2>
      {canManage && <Link className="taxonomy-button taxonomy-button--primary" href="/staff/catalog/taxonomy?category=new">
        <Plus size={15} aria-hidden="true" /> New category
      </Link>}
    </div>
    <label className="taxonomy-search"><span>Search categories</span><span>
      <Search size={15} aria-hidden="true" />
      <input type="search" placeholder="Find by name or slug" value={search} onChange={event => setSearch(event.target.value)} />
    </span></label>
    {canManage && index >= 0 && <div className="taxonomy-reorder">
      <span className="taxonomy-muted">Sibling order</span>
      <button className="taxonomy-button" type="button" disabled={operation.pending || index === 0} onClick={() => reorder(-1)}>
        <ArrowUp size={15} aria-hidden="true" /> Move up
      </button>
      <button className="taxonomy-button" type="button" disabled={operation.pending || index >= siblings.length - 1} onClick={() => reorder(1)}>
        <ArrowDown size={15} aria-hidden="true" /> Move down
      </button>
    </div>}
    <TaxonomyFeedback {...operation} />
    {tree.length ? <nav className="taxonomy-tree-list" aria-label="Categories"><TreeBranch nodes={tree} selected={selected} /></nav>
      : <p className="taxonomy-muted">{search ? "No categories match your search." : "Create a department to start organizing categories."}</p>}
  </aside>;
}
