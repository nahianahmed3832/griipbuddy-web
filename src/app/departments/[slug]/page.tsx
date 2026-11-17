import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ListingPage } from "@/components/listing-page";
import type { SearchParams } from "@/lib/catalog/listing";
import { departmentFamily, stockedDepartments } from "@/lib/catalog/departments";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl } from "@/lib/release-config";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const department = await catalog.getDepartment((await params).slug);
  return { title: department?.name ?? "Department not found", description: department?.description, alternates: department ? { canonical: canonicalUrl(`/departments/${department.slug}`) } : undefined };
}

export default async function DepartmentPage({ params, searchParams }: Props) {
  const [{ slug }, market, departments, filters] = await Promise.all([params, currentMarket(), catalog.listDepartments(), searchParams]);
  const department = await catalog.getDepartment(slug);
  if (!department) notFound();
  const departmentIds = Array.from(departmentFamily(departments, department.id));
  const products = await catalog.listProducts({ marketId: market.id, departmentIds, leadImageOnly: true });
  const childDepartments = stockedDepartments(departments, products.map(product => product.departmentId))
    .filter(item => item.parentId === department.id);
  const parentDepartment = departments.find(item => item.id === department.parentId);
  return <ListingPage path={`/departments/${slug}`} title={department.name} description={department.description} params={filters}
    departmentPage {...{ market, departments, products, childDepartments, parentDepartment }} />;
}
