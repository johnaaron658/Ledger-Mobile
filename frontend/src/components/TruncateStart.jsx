// Single-line text that truncates at the *start* ("…BPI:9222") instead of the
// end, for ledger account paths whose most specific segment is the last one.
// The rtl direction moves the ellipsis to the left edge; <bdi> keeps the
// actual characters in their normal left-to-right order.
export default function TruncateStart({ text, className = '' }) {
  return (
    <span className={`truncate-start ${className}`} title={text}>
      <bdi>{text}</bdi>
    </span>
  );
}
