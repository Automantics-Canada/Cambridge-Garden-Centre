import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

export default function Modal({ isOpen, onClose, title, children }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-scrim/50 z-40"
          />

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="bg-surface rounded-card shadow-lift max-w-2xl w-full max-h-[90vh] flex flex-col pointer-events-auto border border-line"
            >
              <div className="sticky top-0 bg-surface border-b border-line px-6 py-4 flex items-center justify-between">
                <h2 className="text-xl font-bold text-ink">{title}</h2>
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-ink/[0.05] rounded-control transition-colors"
                >
                  <X size={20} className="text-muted" />
                </button>
              </div>

              <div className="p-6 overflow-y-auto">
                {children}
              </div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
