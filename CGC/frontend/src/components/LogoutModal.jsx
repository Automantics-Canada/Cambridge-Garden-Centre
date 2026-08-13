import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LogOut, X } from 'lucide-react';
import { Button } from './ui';

export default function LogoutModal({ isOpen, onClose, onConfirm }) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-scrim/50 backdrop-blur-xs"
          />

          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            className="relative bg-surface rounded-card shadow-lift max-w-sm w-full p-6 text-center z-10 overflow-hidden border border-line"
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-muted hover:text-ink transition-colors p-1 rounded-pill hover:bg-ink/[0.05]"
            >
              <X size={18} />
            </button>

            <div className="w-12 h-12 rounded-pill bg-clay/14 text-clay flex items-center justify-center mx-auto mb-4">
              <LogOut size={24} />
            </div>

            <h3 className="text-lg font-bold text-ink mb-1">
              Confirm logout
            </h3>
            <p className="text-sm text-muted mb-6">
              Are you sure you want to log out of your account?
            </p>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                onClick={onClose}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  onConfirm();
                  onClose();
                }}
                className="flex-1"
              >
                Log out
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
