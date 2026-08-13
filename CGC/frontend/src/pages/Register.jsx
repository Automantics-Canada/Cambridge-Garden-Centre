import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, Link } from 'react-router-dom';
import { registerAsync, clearError } from '../store/authSlice';
import { Eye, EyeOff } from 'lucide-react';
import { Button, Card, CardBody, Field, Input, Select, ThemeToggle } from '../components/ui';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState('ADMIN'); // Default to AP_USER or ADMIN based on backend roles
  const [successMsg, setSuccessMsg] = useState('');

  const dispatch = useDispatch();
  const navigate = useNavigate();

  const { loading, error, isAuthenticated } = useSelector((state) => state.auth);

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate]);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (email && password && name) {
      dispatch(clearError());
      const result = await dispatch(registerAsync({ email, password, name, role }));
      if (registerAsync.fulfilled.match(result)) {
        setSuccessMsg('Registration successful! Redirecting to login...');
        setTimeout(() => navigate('/login'), 2000);
      }
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-md">
        <CardBody className="pt-8">
          <div className="text-center mb-8">
            <h1 className="text-[30px] font-bold text-ink tracking-[-0.015em] leading-tight">
              Create an account
            </h1>
            <p className="text-sm text-muted mt-1.5">
              Join Cambridge Garden Centre operations.
            </p>
          </div>

          {successMsg && (
            <div className="mb-4 bg-brand/12 border border-brand/30 text-brand px-4 py-3 rounded-control text-sm">
              {successMsg}
            </div>
          )}

          {error && (
            <div className="mb-4 bg-clay/14 border border-clay/30 text-clay px-4 py-3 rounded-control text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleRegister} className="space-y-4">
            <Field label="Full name" htmlFor="register-name">
              <Input
                id="register-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sarah K."
                required
              />
            </Field>
            <Field label="Email" htmlFor="register-email">
              <Input
                id="register-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="sarah@example.com"
                required
              />
            </Field>
            <Field label="Password" htmlFor="register-password">
              <div className="relative">
                <Input
                  id="register-password"
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
            <Field label="Role" htmlFor="register-role">
              <Select
                id="register-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="AP_USER">AP User</option>
                <option value="ADMIN">Admin</option>
                <option value="OWNER">Owner</option>
              </Select>
            </Field>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || successMsg !== ''}
              className="w-full mt-2"
            >
              {loading ? 'Registering...' : 'Register'}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted">
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-brand hover:underline">
              Sign in
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
