import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Eye,
  EyeOff,
  Leaf,
  PackageCheck,
  ReceiptText,
  Route,
  ShieldCheck,
} from 'lucide-react';
import { loginAsync, clearError } from '../store/authSlice';
import { takeSessionNotice } from '../lib/session';
import { Button, Field, Input, ThemeToggle } from '../components/ui';

const WORKFLOW = [
  {
    icon: PackageCheck,
    label: 'Orders imported',
    detail: 'Keep incoming work organised from the start.',
  },
  {
    icon: Route,
    label: 'Deliveries dispatched',
    detail: 'Give every driver a clear next stop.',
  },
  {
    icon: ReceiptText,
    label: 'Documents matched',
    detail: 'Connect tickets and invoices back to the order.',
  },
];

const PANEL = {
  hidden: { opacity: 0, y: 18 },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  },
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Consumed once on mount so an expired session explains itself here rather
  // than looking like an outage on the dashboard.
  const [notice, setNotice] = useState(() => takeSessionNotice());
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const isDriverLogin = location.pathname === '/login/driver';

  const { loading, error, isAuthenticated, user } = useSelector((state) => state.auth);

  // Where the 401 interceptor bounced the user from, so signing back in returns
  // them to the screen they were on. Ignored for drivers, who have one screen.
  const nextPath = new URLSearchParams(location.search).get('next');

  useEffect(() => {
    if (isAuthenticated && user) {
      if (user.role === 'DRIVER') {
        navigate('/driver/today');
        return;
      }
      navigate(nextPath && nextPath.startsWith('/') ? nextPath : '/dashboard');
    }
  }, [isAuthenticated, user, navigate, nextPath]);

  const handleLogin = (event) => {
    event.preventDefault();
    if (!email || !password) return;
    setNotice(null);
    dispatch(clearError());
    dispatch(loginAsync({ email, password }));
  };

  const motionProps = reduceMotion
    ? { initial: false }
    : { initial: 'hidden', animate: 'shown', variants: PANEL };

  return (
    <main className="min-h-screen bg-canvas text-ink lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(480px,0.92fr)]">
      <section className="relative isolate min-h-[260px] overflow-hidden bg-brand px-6 py-7 text-on-brand sm:px-10 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
          <div className="absolute -left-24 -top-32 h-80 w-80 rounded-full border border-on-brand/15" />
          <div className="absolute -left-8 -top-16 h-80 w-80 rounded-full border border-on-brand/10" />
          <div className="absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-on-brand/[0.06]" />
          <div className="absolute bottom-10 right-10 h-36 w-36 rounded-full border border-on-brand/10" />
        </div>

        <div className="relative z-10 flex h-full min-h-[210px] flex-col lg:min-h-[calc(100vh-6rem)]">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-control bg-on-brand/12 ring-1 ring-on-brand/20">
              <Leaf size={23} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div>
              <p className="text-[17px] font-semibold leading-tight tracking-[-0.01em]">Cambridge</p>
              <p className="text-[13px] text-on-brand/70">Garden Centre</p>
            </div>
          </div>

          <motion.div
            {...motionProps}
            className="mt-auto max-w-2xl pb-2 pt-14 lg:pb-8"
          >
            <p className="mb-4 hidden items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-on-brand/65 sm:flex">
              <span className="h-px w-8 bg-on-brand/40" />
              One connected workspace
            </p>
            <h1 className="max-w-xl text-[38px] font-semibold leading-[1.04] tracking-[-0.035em] sm:text-5xl lg:text-[58px]">
              Every order, delivery and invoice in view.
            </h1>
            <p className="mt-5 max-w-lg text-[15px] leading-7 text-on-brand/72 sm:text-base">
              A calmer way to move work from the first order file to proof of delivery and final invoice review.
            </p>

            <div className="mt-9 hidden grid-cols-3 gap-3 lg:grid">
              {WORKFLOW.map(({ icon: Icon, label, detail }) => (
                <div
                  key={label}
                  className="rounded-card border border-on-brand/15 bg-on-brand/[0.07] p-4 backdrop-blur-sm"
                >
                  <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                  <p className="mt-6 text-sm font-semibold">{label}</p>
                  <p className="mt-1 text-xs leading-5 text-on-brand/65">{detail}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      <section className="relative flex min-h-[calc(100vh-260px)] items-center justify-center px-6 py-12 sm:px-10 lg:min-h-screen lg:px-14">
        <div className="absolute right-5 top-5">
          <ThemeToggle className="border border-line bg-surface shadow-card" />
        </div>

        <motion.div {...motionProps} className="w-full max-w-md">
          <div className="mb-9">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-control bg-brand/10 text-brand">
              <ShieldCheck size={23} strokeWidth={1.8} aria-hidden="true" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
              Secure staff access
            </p>
            <h2 className="mt-3 text-[34px] font-semibold leading-tight tracking-[-0.025em]">
              {isDriverLogin ? 'Driver sign in' : 'Welcome back'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {isDriverLogin
                ? "Sign in to open today's route and delivery tasks."
                : 'Sign in to continue to Cambridge Garden Centre.'}
            </p>
          </div>

          {notice && !error && (
            <div
              role="status"
              className="mb-5 rounded-control border border-brand/30 bg-brand/10 px-4 py-3 text-sm text-brand"
            >
              {notice}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-5 rounded-control border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            <Field label="Email" htmlFor="login-email">
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="sarah@example.com"
                autoComplete="email"
                autoFocus
                required
              />
            </Field>

            <Field label="Password" htmlFor="login-password">
              <div className="relative">
                <Input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="pr-11"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-pill text-muted transition-colors hover:bg-ink/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/35"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </Field>

            <motion.div
              whileTap={reduceMotion || loading ? undefined : { scale: 0.985 }}
              transition={{ type: 'spring', stiffness: 420, damping: 20 }}
            >
              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                className="group w-full"
              >
                <span>{loading ? 'Signing in…' : 'Sign in'}</span>
                {!loading && (
                  <ArrowRight
                    size={17}
                    className="ml-2 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                )}
              </Button>
            </motion.div>
          </form>

          {!isDriverLogin && (
            <p className="mt-8 border-t border-line pt-6 text-sm text-muted">
              Need access? Contact a Cambridge Garden Centre administrator.
            </p>
          )}
        </motion.div>
      </section>
    </main>
  );
}
