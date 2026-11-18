import { Download } from "lucide-react";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";

export function OrderDocumentLink({ orderPath, reference, language, kind, className }: {
  orderPath: string;
  reference: string;
  language: AccountLanguage;
  kind: "payment-receipt" | "order-summary";
  className?: string;
}) {
  const label = kind === "payment-receipt"
    ? accountText(language, "Download receipt (PDF)", "রসিদ ডাউনলোড করুন (PDF)")
    : accountText(language, "Download order summary (PDF)", "অর্ডারের সারাংশ ডাউনলোড করুন (PDF)");

  return <a className={className ? `order-document-link ${className}` : "order-document-link"}
    href={storefrontPath(marketStoreHref(`${orderPath}/receipt`, "bd"))}>
    <Download size={16} aria-hidden="true" />
    <span>{label}<span className="sr-only"> · {reference}</span></span>
  </a>;
}
