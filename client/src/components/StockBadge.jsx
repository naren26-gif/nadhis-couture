export default function StockBadge({ onHand }) {
  if (onHand <= 0) return <span className="badge bad">Out of stock</span>;
  if (onHand <= 2) return <span className="badge warn">{onHand} left</span>;
  return <span className="badge good">{onHand} in stock</span>;
}
