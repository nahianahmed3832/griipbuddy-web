import type { ReactNode } from "react";

export function Scores({ entries }: { entries: readonly { label: string; value: ReactNode }[] }) {
  return <dl className="intel-scores">{entries.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function IntelligenceTable({ label, columns, children }: { label: string; columns: readonly string[]; children: ReactNode }) {
  return <div className="intel-table" role="region" aria-label={label} tabIndex={0}><table>
    <thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}

export function TextList({ entries }: { entries: readonly string[] }) {
  return entries.length ? <ul>{entries.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ul> : null;
}

export function percentage(numerator: number, denominator: number) {
  return denominator ? `${(100 * numerator / denominator).toFixed(1)}%` : "Unavailable";
}
