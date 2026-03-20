export const ERD_NODE_WIDTH = 280
export const ERD_NODE_HEADER_HEIGHT = 42
export const ERD_NODE_ROW_HEIGHT = 28
export const ERD_NODE_FOOTER_HEIGHT = 34
export const ERD_NODE_CARD_CHROME_HEIGHT = 6
export const ERD_NODE_DEFAULT_VISIBLE_COLUMNS = 10

export function estimateErdNodeHeight(columnCount: number, expanded: boolean): number {
  // When expanded, render every column — no height cap. ELK needs the true height
  // so it allocates enough vertical space and nodes don't overlap.
  const visibleRows = expanded
    ? columnCount
    : Math.min(columnCount, ERD_NODE_DEFAULT_VISIBLE_COLUMNS)
  const hasFooter = columnCount > ERD_NODE_DEFAULT_VISIBLE_COLUMNS

  return (
    ERD_NODE_HEADER_HEIGHT +
    visibleRows * ERD_NODE_ROW_HEIGHT +
    (hasFooter ? ERD_NODE_FOOTER_HEIGHT : 0) +
    ERD_NODE_CARD_CHROME_HEIGHT
  )
}
