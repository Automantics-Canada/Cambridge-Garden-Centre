import React, { useRef } from 'react';
import {
  motion,
  useSpring,
  useTransform,
  useReducedMotion,
} from 'framer-motion';
import { cn } from '../../lib/cn';
import { tiltFromPointer } from '../../lib/tilt';


/**
 * A panel that leans toward the pointer.
 *
 * Real CSS 3D, not a fake shear: the wrapper owns the `perspective` and the
 * inner surface rotates inside it, so the far edge genuinely foreshortens.
 * Rotation is capped low on purpose — past about 8° the text edges start to
 * soften and it reads as a gimmick rather than depth.
 *
 * The tilt is decoration. It is skipped entirely when the visitor asks for
 * reduced motion, and on touch devices, where there is no hover pointer to
 * follow and the handlers would only cost work on every scroll.
 */
export default function TiltCard({
  children,
  className,
  maxTilt = 6,
  ...props
}) {
  const reduceMotion = useReducedMotion();
  const ref = useRef(null);

  // Spring-backed rotation, written directly by the pointer handler. Setting a
  // spring animates it to the new value, so the card settles rather than
  // snapping to the cursor.
  const spring = { stiffness: 150, damping: 18, mass: 0.4 };
  const rotateX = useSpring(0, spring);
  const rotateY = useSpring(0, spring);

  // Lift the shadow as the card turns away from flat, so the depth cue agrees
  // with the rotation instead of staying pinned to the resting state.
  const lean = useTransform([rotateX, rotateY], ([rx, ry]) =>
    Math.min(1, (Math.abs(rx) + Math.abs(ry)) / (maxTilt * 2))
  );
  const shadow = useTransform(
    lean,
    [0, 1],
    [
      '0 1px 2px rgb(26 31 28 / 0.04), 0 8px 24px rgb(26 31 28 / 0.06)',
      '0 1px 2px rgb(26 31 28 / 0.06), 0 22px 48px rgb(26 31 28 / 0.16)',
    ]
  );

  const isCoarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  const inert = reduceMotion || isCoarsePointer;

  const handlePointerMove = (event) => {
    if (inert || !ref.current) return;
    const { rotateX: rx, rotateY: ry } = tiltFromPointer(
      ref.current.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      maxTilt
    );
    rotateX.set(rx);
    rotateY.set(ry);
  };

  const handlePointerLeave = () => {
    if (inert) return;
    rotateX.set(0);
    rotateY.set(0);
  };

  if (inert) {
    return (
      <div
        className={cn(
          'bg-surface border border-line rounded-card shadow-card',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{ perspective: 1200 }}
      {...props}
    >
      <motion.div
        style={{ rotateX, rotateY, boxShadow: shadow, transformStyle: 'preserve-3d' }}
        className={cn('bg-surface border border-line rounded-card', className)}
      >
        {children}
      </motion.div>
    </div>
  );
}
