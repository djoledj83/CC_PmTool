import { Link, useNavigate } from 'react-router-dom';
import { LogOut, LayoutDashboard } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

export function Navbar() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = async () => {
        await logout();
        navigate('/login');
    };

    if (!user) return null;

    return (
        <header className="border-b bg-background">
            <div className="container flex h-14 items-center justify-between">
                <Link to="/" className="flex items-center gap-2 font-semibold">
                    <LayoutDashboard className="h-5 w-5 text-primary" />
                    <span>PM Tool</span>
                </Link>
                <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">{user.name}</span>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleLogout}
                        className="gap-2"
                    >
                        <LogOut className="h-4 w-4" />
                        Log out
                    </Button>
                </div>
            </div>
        </header>
    );
}
