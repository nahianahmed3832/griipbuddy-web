"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import type { Department } from "@/lib/catalog/types";

export function DepartmentMenu({ departments }: { departments: readonly Department[] }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  function close() {
    if (menu.current) menu.current.open = false;
  }

  return (
    <details
      ref={menu}
      className="department-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          close();
          trigger.current?.focus();
        }
      }}
    >
      <summary ref={trigger} aria-label="Categories">
        <Menu size={19} aria-hidden="true" />
        <span>Categories</span>
      </summary>
      <nav aria-label="Browse categories">
        <Link href="/shop" onClick={close}>Shop all</Link>
        {departments.map((department) => (
          <Link key={department.id} href={`/departments/${department.slug}`} onClick={close}>{department.name}</Link>
        ))}
      </nav>
    </details>
  );
}
