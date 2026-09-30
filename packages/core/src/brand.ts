// No imports: the web dashboard bundles this for the browser.

/**
 * The 0bridge mark (G5 "Deck"): an arch standing on a deck, a bridge seen from the side, inside
 * a rounded app-icon tile. One drawing for the site header, the favicons, and the icon other
 * services show (Slack's app, OAuth consent screens, MCP clients). The concepts it was picked
 * from are in docs/brand/.
 *
 * Small sizes need heavier strokes to stay legible, so `weight` picks the stroke set:
 * "regular" from 28 px up, "small" for 20–24 px, "tiny" for 16 px.
 */
export type MarkWeight = "regular" | "small" | "tiny";

const WEIGHTS: Record<MarkWeight, { stroke: number }> = {
  regular: { stroke: 8.1 },
  small: { stroke: 10.4 },
  tiny: { stroke: 11.9 },
};

export interface MarkOptions {
  /** Rendered width and height in px. */
  size: number;
  weight?: MarkWeight;
  /** Tile color; "currentColor" follows the text color. */
  tile?: string;
  /** Color of the arch and deck, usually the page background so the mark inverts in dark mode. */
  glyph?: string;
  /** "rounded" for the app-icon tile, "square" for full-bleed icons (iOS, Slack round the corners themselves). */
  shape?: "rounded" | "square";
  /** Accessible name; without it the mark is decorative (aria-hidden). */
  label?: string;
}

/** The mark as an SVG string (96-unit viewBox). */
export function markSvg({ size, weight = "regular", tile = "#080808", glyph = "#FFFFFF", shape = "rounded", label }: MarkOptions): string {
  const { stroke } = WEIGHTS[weight];
  const a11y = label ? `role="img" aria-label="${label.replace(/[&<>"]/g, "")}"` : `aria-hidden="true"`;
  // Colors go in `style` so CSS variables work (presentation attributes don't take var()).
  const fill = (c: string) => `style="fill:${c}"`;
  const bg = shape === "square" ? `<rect width="96" height="96" ${fill(tile)}/>` : `<rect x="4" y="4" width="88" height="88" rx="22" ${fill(tile)}/>`;
  const line = `style="fill:none;stroke:${glyph}" stroke-width="${stroke}" stroke-linecap="round"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96" ${a11y}>${bg}` +
    `<path d="M23.58 56.91H72.42" ${line}/>` +
    `<path d="M32.82 56.91C32.82 33.15 63.18 33.15 63.18 56.91" ${line}/></svg>`
  );
}

/**
 * Just the glyph (arch and deck, no tile), cropped to its own bounds, for places where the mark
 * sits in a row of text at a given height (the nav bars). Wider than tall (about 2.2 : 1).
 */
export function glyphSvg({ height, color = "currentColor", stroke = WEIGHTS.regular.stroke, label }: { height: number; color?: string; stroke?: number; label?: string }): string {
  const a11y = label ? `role="img" aria-label="${label.replace(/[&<>"]/g, "")}"` : `aria-hidden="true"`;
  const h = stroke / 2;
  // Deck from x 23.58 to 72.42 at y 56.91; the arch peaks at y 39.09 (its Bézier at t = 0.5).
  const [x, y, w, hh] = [23.58 - h, 39.09 - h, 72.42 - 23.58 + stroke, 56.91 - 39.09 + stroke];
  const width = Math.round((height * w) / hh);
  const line = `style="fill:none;stroke:${color}" stroke-width="${stroke}" stroke-linecap="round"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${hh.toFixed(2)}" ${a11y}>` +
    `<path d="M23.58 56.91H72.42" ${line}/><path d="M32.82 56.91C32.82 33.15 63.18 33.15 63.18 56.91" ${line}/></svg>`
  );
}
