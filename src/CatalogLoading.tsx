export function CatalogLoading({ kind, label }: { kind: 'expert' | 'skill' | 'connector'; label: string }) {
  return <div className={`catalog-loading ${kind}`} role="status">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="catalog-skeleton-grid">{Array.from({ length: kind === 'skill' ? 6 : 4 }, (_, index) => <div className="catalog-skeleton" key={index}><span /><i /><i /><i /></div>)}</div>
  </div>
}
