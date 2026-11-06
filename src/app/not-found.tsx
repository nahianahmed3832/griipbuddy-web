import Link from 'next/link';

export default function NotFound() {
  return <div className="container interior"><div className="empty-state">
    <p className="eyebrow">404</p><h1>Page not found</h1>
    <Link href="/" className="button button-primary">Back to GriipBuddy</Link>
  </div></div>;
}
