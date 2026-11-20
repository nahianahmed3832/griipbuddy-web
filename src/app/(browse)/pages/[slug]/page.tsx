import { notFound } from "next/navigation";
import { EditorialDetail, editorialMetadata, findEditorial } from "@/components/marketplace/editorial";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { document, market } = await findEditorial("PAGE", (await params).slug);
  return editorialMetadata(document, market);
}

export default async function Document({ params }: Props) {
  const { document, market, category } = await findEditorial("PAGE", (await params).slug);
  if (!document) notFound();
  return <EditorialDetail document={document} market={market} category={category} />;
}
