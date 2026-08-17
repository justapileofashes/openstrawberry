/**
 * The travelling highlight layer for a glass surface.
 *
 * Two pools of light on different periods, clipped to the panel. Sizing and
 * travel paths are defined per-surface in CSS, because a tall rail and a wide
 * top bar want the light moving along different axes.
 *
 * The layer clips its own contents rather than the panel setting
 * `overflow: hidden`, which would cut off the tooltip bubbles that deliberately
 * escape the top bar.
 */
export function GlassSheen(): React.JSX.Element {
  return (
    <span className="sheen" aria-hidden="true">
      <span className="sheen-blob sheen-a" />
      <span className="sheen-blob sheen-b" />
    </span>
  );
}
