import type { Department } from "./types.ts";

export type DepartmentNode<T = Department> = T & { children: DepartmentNode<T>[] };

export function departmentAncestorPath<T extends { id: string; parentId?: string | null }>(
  departments: ReadonlyMap<string, T>, id: string,
): T[] | null {
  const path: T[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined = id;
  while (current) {
    const node = departments.get(current);
    if (!node || seen.has(current)) return null;
    path.push(node);
    seen.add(current);
    current = node.parentId;
  }
  return path.reverse();
}

export function departmentTree<T extends { id: string; parentId?: string | null }>(departments: readonly T[]): DepartmentNode<T>[] {
  const nodes = new Map(departments.map(department => [department.id, { ...department, children: [] } as DepartmentNode<T>]));
  const roots: DepartmentNode<T>[] = [];
  for (const department of nodes.values()) {
    const parent = department.parentId && nodes.get(department.parentId);
    if (parent) parent.children.push(department);
    else roots.push(department);
  }
  return roots;
}

export function departmentFamily(departments: readonly { id: string; parentId?: string | null }[], id: string): Set<string> {
  const family = new Set([id]);
  const children = new Map<string, string[]>();
  for (const department of departments) {
    if (!department.parentId) continue;
    const siblings = children.get(department.parentId) ?? [];
    siblings.push(department.id);
    children.set(department.parentId, siblings);
  }
  for (const member of family) {
    for (const child of children.get(member) ?? []) family.add(child);
  }
  return family;
}

export function stockedDepartments(departments: readonly Department[], occupied: readonly string[]): Department[] {
  const visible = new Set(occupied);
  const byId = new Map(departments.map(department => [department.id, department]));
  for (const id of visible) {
    const parentId = byId.get(id)?.parentId;
    if (parentId) visible.add(parentId);
  }
  return departments.filter(department => visible.has(department.id));
}
