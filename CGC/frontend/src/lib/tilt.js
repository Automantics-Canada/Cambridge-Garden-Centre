/**
 * Rotation for a pointer at (clientX, clientY) over `rect`.
 *
 * Lives here rather than beside TiltCard because a module that exports both a
 * component and a plain function breaks React Fast Refresh.
 *
 * It is also the only testable half of the effect: the spring that consumes
 * these values animates on requestAnimationFrame, which does not run in a
 * headless check.
 *
 * The pointer maps to -0.5 (top/left) .. 0.5 (bottom/right) of the card, then
 * to +/- maxTilt degrees. Negative rotateX brings the top edge toward the
 * viewer, so the card leans into the pointer rather than away from it.
 */
export function tiltFromPointer(rect, clientX, clientY, maxTilt) {
  if (!rect || !rect.width || !rect.height) return { rotateX: 0, rotateY: 0 };
  const nx = (clientX - rect.left) / rect.width - 0.5;
  const ny = (clientY - rect.top) / rect.height - 0.5;
  const clamp = (v) => Math.max(-maxTilt, Math.min(maxTilt, v));
  return {
    rotateX: clamp(-ny * maxTilt * 2),
    rotateY: clamp(nx * maxTilt * 2),
  };
}
