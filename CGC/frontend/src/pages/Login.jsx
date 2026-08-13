import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, useLocation } from 'react-router-dom';
import { loginAsync, clearError } from '../store/authSlice';
import { FadeInUp } from '../components/Animated';
import { Eye, EyeOff } from 'lucide-react';
import { Button, Card, CardBody, Field, Input, ThemeToggle } from '../components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const isDriverLogin = location.pathname === '/login/driver';

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
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <FadeInUp className="w-full max-w-md">
        <Card>
          <CardBody className="pt-8">
            <div className="text-center mb-8">
              <h1 className="text-[30px] font-bold text-ink tracking-[-0.015em] leading-tight">
                Sign in
              </h1>
              <p className="text-sm text-muted mt-1.5">
                Welcome back to Cambridge Garden Centre.
              </p>
            </div>

            {error && (
              <div className="mb-4 bg-clay/14 border border-clay/30 text-clay px-4 py-3 rounded-control text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-5">
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
              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                className="w-full"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </Button>
            </form>

            {!isDriverLogin && (
              <p className="mt-6 text-center text-sm text-muted">
                Need access? Contact a CGC administrator.
              </p>
            )}
          </CardBody>
        </Card>
      </FadeInUp>
    </div>
  );
}
