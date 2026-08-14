import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { loginAsync, clearError } from '../store/authSlice';
import { Eye, EyeOff } from 'lucide-react';
import { Button, CardBody, Field, Input, ThemeToggle } from '../components/ui';
import TiltCard from '../components/ui/TiltCard';
import AuroraField from '../components/ui/AuroraField';

/**
 * Entrance sequence. The card arrives first, then its contents climb in 60ms
 * apart — close enough to feel like one movement, far enough apart to read as
 * deliberate. `staggerChildren` is set on the container so the order follows
 * the DOM and cannot drift out of sync with the markup.
 */
const CONTENTS = {
  hidden: {},
  shown: { transition: { delayChildren: 0.18, staggerChildren: 0.06 } },
};

const ROW = {
  hidden: { opacity: 0, y: 14 },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  },
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const isDriverLogin = location.pathname === '/login/driver';
  const reduceMotion = useReducedMotion();

  const { loading, error, isAuthenticated, user } = useSelector((state) => state.auth);

  useEffect(() => {
    if (isAuthenticated && user) {
      if (user.role === 'DRIVER') {
        navigate('/driver/today');
      } else {
        navigate('/dashboard');
      }
    }
  }, [isAuthenticated, user, navigate]);

  const handleLogin = (e) => {
    e.preventDefault();
    if (email && password) {
      dispatch(clearError());
      dispatch(loginAsync({ email, password }));
    }
  };

  return (
    <div className="relative min-h-screen bg-canvas flex items-center justify-center p-4 overflow-hidden">
      <AuroraField />

      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <motion.div
        className="relative w-full max-w-md"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <TiltCard>
          <motion.div variants={CONTENTS} initial="hidden" animate="shown">
            <CardBody className="pt-8">
              <motion.div variants={ROW} className="text-center mb-8">
                <h1 className="text-[30px] font-bold text-ink tracking-[-0.015em] leading-tight">
                  Sign in
                </h1>
                <p className="text-sm text-muted mt-1.5">
                  Welcome back to Cambridge Garden Centre.
                </p>
              </motion.div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-4 bg-clay/14 border border-clay/30 text-clay px-4 py-3 rounded-control text-sm"
                >
                  {error}
                </motion.div>
              )}

              <form onSubmit={handleLogin} className="space-y-5">
                <motion.div variants={ROW}>
                  <Field label="Email" htmlFor="login-email">
                    <Input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="sarah@example.com"
                      required
                    />
                  </Field>
                </motion.div>

                <motion.div variants={ROW}>
                  <Field label="Password" htmlFor="login-password">
                    <div className="relative">
                      <Input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pr-10"
                        placeholder="••••••••"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink focus:outline-none"
                      >
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </Field>
                </motion.div>

                <motion.div variants={ROW}>
                  {/* The press spring lives on a wrapper, not on Button itself,
                      so the shared Button stays a plain styled control. */}
                  <motion.div
                    whileTap={reduceMotion || loading ? undefined : { scale: 0.975 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                  >
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={loading}
                      className="w-full"
                    >
                      {loading ? 'Signing in...' : 'Sign in'}
                    </Button>
                  </motion.div>
                </motion.div>
              </form>

              {!isDriverLogin && (
                <motion.p variants={ROW} className="mt-6 text-center text-sm text-muted">
                  Need access? Contact a CGC administrator.
                </motion.p>
              )}
            </CardBody>
          </motion.div>
        </TiltCard>
      </motion.div>
    </div>
  );
}
