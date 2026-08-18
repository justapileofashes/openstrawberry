/**
 * The ambient light field behind the whole workspace.
 *
 * This is a single field spanning the window, not a per-panel effect. The glass
 * chrome does not own its highlight; it reveals whatever part of this field
 * happens to sit behind it, blurred through `backdrop-filter`. That is why a
 * pool can drift out from under the rail, cross behind the page area, and
 * re-emerge under the top bar as one continuous movement.
 *
 * An earlier version clipped a copy of the light inside each panel. Because
 * each copy was confined to its own box, the light read as running on a rail
 * rather than as a background the chrome floats over.
 */
export function AmbientField(): React.JSX.Element {
  return (
    <div className="ambient" aria-hidden="true">
      {/*
        The beat lands on this wrapper rather than on the pools themselves. Each
        pool's own `transform` is already spoken for by its drift keyframes, and
        a second transform on the same element would overwrite the first. Since
        the wrapper spans the field exactly, scaling it swells every pool about
        the centre of the window without moving any of them relative to their
        paths - and the clipping stays on `.ambient` outside it, so a swell
        cannot push light past the window edge.
      */}
      <div className="ambient-pulse">
        <span className="ambient-blob blob-1" />
        <span className="ambient-blob blob-2" />
        <span className="ambient-blob blob-3" />
        <span className="ambient-blob blob-4" />
      </div>
    </div>
  );
}
