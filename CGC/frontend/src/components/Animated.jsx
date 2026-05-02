import React from 'react';
import { motion } from 'framer-motion';

/**
 * A wrapper component that provides a "coming upside" entrance animation.
 */
export function FadeInUp({ children, delay = 0, duration = 0.4, className = "", component = "div" }) {
  const Component = motion[component];
  return (
    <Component
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ 
        duration: duration, 
        delay: delay,
        ease: [0.25, 0.1, 0.25, 1] 
      }}
      className={className}
    >
      {children}
    </Component>
  );
}

/**
 * A wrapper for lists that staggers the entrance of its children.
 */
export function StaggerContainer({ children, delayChildren = 0, staggerBy = 0.1, className = "", component = "div" }) {
  const Component = motion[component];
  return (
    <Component
      initial="hidden"
      animate="show"
      variants={{
        hidden: { opacity: 0 },
        show: {
          opacity: 1,
          transition: {
            delayChildren: delayChildren,
            staggerChildren: staggerBy
          }
        }
      }}
      className={className}
    >
      {children}
    </Component>
  );
}

/**
 * To be used inside StaggerContainer.
 */
export function StaggerItem({ children, className = "", component = "div" }) {
  const Component = motion[component];
  return (
    <Component
      variants={{
        hidden: { opacity: 0, y: 20 },
        show: { opacity: 1, y: 0, transition: { ease: [0.25, 0.1, 0.25, 1] } }
      }}
      className={className}
    >
      {children}
    </Component>
  );
}
