/**
 * The tilt itself animates through a framer-motion spring, which ticks on
 * requestAnimationFrame. rAF does not run in a headless check, so the rendered
 * rotation cannot be asserted here. `tiltFromPointer` is the part that can be:
 * it is pure, and it decides both the direction and the magnitude of the lean.
 */
import { describe, it, expect } from 'vitest';
import { tiltFromPointer } from './tilt';

/** A 400x300 card at viewport (100, 50). */
const rect = { left: 100, top: 50, width: 400, height: 300 };
const MAX = 6;
const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

describe('tiltFromPointer', () => {
  it('is flat at the centre', () => {
    const t = tiltFromPointer(rect, centre.x, centre.y, MAX);
    expect(t.rotateX).toBeCloseTo(0);
    expect(t.rotateY).toBeCloseTo(0);
  });

  it('reaches exactly maxTilt at the corners, never more', () => {
    const topLeft = tiltFromPointer(rect, rect.left, rect.top, MAX);
    expect(topLeft.rotateX).toBeCloseTo(MAX);
    expect(topLeft.rotateY).toBeCloseTo(-MAX);

    const bottomRight = tiltFromPointer(
      rect,
      rect.left + rect.width,
      rect.top + rect.height,
      MAX
    );
    expect(bottomRight.rotateX).toBeCloseTo(-MAX);
    expect(bottomRight.rotateY).toBeCloseTo(MAX);
  });

  it('leans into the pointer rather than away from it', () => {
    // Pointer above centre -> negative rotateX brings the top edge forward.
    const above = tiltFromPointer(rect, centre.x, rect.top + 10, MAX);
    expect(above.rotateX).toBeGreaterThan(0);

    const below = tiltFromPointer(rect, centre.x, rect.top + rect.height - 10, MAX);
    expect(below.rotateX).toBeLessThan(0);

    const right = tiltFromPointer(rect, rect.left + rect.width - 10, centre.y, MAX);
    expect(right.rotateY).toBeGreaterThan(0);

    const left = tiltFromPointer(rect, rect.left + 10, centre.y, MAX);
    expect(left.rotateY).toBeLessThan(0);
  });

  it('clamps when the pointer runs outside the card', () => {
    // Pointer capture and fast movement can both deliver out-of-bounds points.
    const far = tiltFromPointer(rect, rect.left - 5000, rect.top - 5000, MAX);
    expect(far.rotateX).toBe(MAX);
    expect(far.rotateY).toBe(-MAX);
    expect(Math.abs(far.rotateX)).toBeLessThanOrEqual(MAX);
  });

  it('scales with maxTilt', () => {
    const small = tiltFromPointer(rect, rect.left, rect.top, 2);
    expect(small.rotateX).toBeCloseTo(2);
    expect(small.rotateY).toBeCloseTo(-2);
  });

  it('stays flat for a zero-sized or missing rect', () => {
    // A card measured before layout would otherwise divide by zero and set NaN
    // on the spring, which silently kills every later update.
    expect(tiltFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 5, 5, MAX))
      .toEqual({ rotateX: 0, rotateY: 0 });
    expect(tiltFromPointer(null, 5, 5, MAX)).toEqual({ rotateX: 0, rotateY: 0 });
  });

  it('never returns NaN', () => {
    for (const [x, y] of [[0, 0], [1e6, 1e6], [centre.x, centre.y]]) {
      const t = tiltFromPointer(rect, x, y, MAX);
      expect(Number.isNaN(t.rotateX)).toBe(false);
      expect(Number.isNaN(t.rotateY)).toBe(false);
    }
  });
});
