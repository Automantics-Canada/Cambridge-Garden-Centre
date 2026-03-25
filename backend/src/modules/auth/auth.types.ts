export interface RegisterBody {
  email: string;
  password: string;
  name: string;
  role?: 'AP_USER' | 'OWNER' | 'ADMIN';
}

export interface LoginBody {
  email: string;
  password: string;
}
