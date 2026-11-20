export function WhatsAppHandoff({ href, subject }: { href?: string; subject: "product" | "order" }) {
  if (!href) return null;
  return <p><a className="button button--outline" href={href} target="_blank" rel="noopener noreferrer"
    referrerPolicy="no-referrer">Ask about this {subject} on WhatsApp</a>{" "}
    <span className="commerce-muted">Opens a draft message.</span></p>;
}
