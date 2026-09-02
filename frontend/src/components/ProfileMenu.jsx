import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.jsx';
import { LogOut, User } from 'lucide-react';
import { currentUser, logout } from '../lib/auth.js';

export default function ProfileMenu() {
  const user = currentUser();
  const initials = (user.username || '?').slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button style={{
          display: 'flex', alignItems: 'center', gap: 10, background: 'transparent',
          border: '1px solid var(--line)', borderRadius: 980, padding: '5px 14px 5px 6px',
          cursor: 'pointer', transition: '.15s',
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--live), #0b7d70)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 10.5, fontWeight: 700,
          }}>
            {initials}
          </div>
          <span style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{user.username}</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" style={{ width: 220, borderRadius: 14, padding: 6 }}>
        <div style={{ padding: '8px 10px 10px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{user.username}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
            {(user.roles && user.roles[0]) || 'operator'}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout} style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px',
          borderRadius: 10, fontSize: 13, color: 'var(--crit)', cursor: 'pointer',
        }}>
          <LogOut size={15} />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}