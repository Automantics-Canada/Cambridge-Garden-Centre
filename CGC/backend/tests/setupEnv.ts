// Placeholder configuration so modules that validate the environment at import
// time can be loaded under test. These are obviously-fake local values; no real
// credential, endpoint or production identifier belongs in this file.
//
// Import this before any src/ module:  import './setupEnv.js';
process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.DIRECT_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SUPABASE_URL ||= 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-only-service-role-key';
process.env.SUPABASE_STORAGE_BUCKET ||= 'test-bucket';
