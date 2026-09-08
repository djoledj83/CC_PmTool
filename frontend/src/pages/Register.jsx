import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CheckCircle2, Mail } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';

const schema = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters'),
});

export default function Register() {
    const { register: registerUser, user, loading } = useAuth();
    const navigate = useNavigate();
    const [submitting, setSubmitting] = useState(false);
    const [pendingEmail, setPendingEmail] = useState(null);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm({ resolver: zodResolver(schema) });

    if (loading) return null;
    if (user) return <Navigate to="/" replace />;

    const onSubmit = async (values) => {
        setSubmitting(true);
        try {
            const result = await registerUser(values);
            if (result?.pending) {
                setPendingEmail(result.user?.email || values.email);
                return;
            }
            toast.success('Account created');
            navigate('/', { replace: true });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Registration failed');
        } finally {
            setSubmitting(false);
        }
    };

    if (pendingEmail) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="items-center text-center">
                        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                            <CheckCircle2 className="h-6 w-6" />
                        </div>
                        <CardTitle>Awaiting approval</CardTitle>
                        <CardDescription>
                            We've created an account for{' '}
                            <span className="font-medium text-foreground">
                                {pendingEmail}
                            </span>
                            .
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-center text-sm text-muted-foreground">
                            An administrator needs to approve your account before
                            you can sign in.
                        </p>
                        <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3 text-left">
                            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <div className="space-y-1 text-xs leading-relaxed">
                                <p className="font-medium text-foreground">
                                    Check your inbox
                                </p>
                                <p className="text-muted-foreground">
                                    We've sent a confirmation to{' '}
                                    <span className="font-medium text-foreground">
                                        {pendingEmail}
                                    </span>
                                    . You'll get another email the moment your
                                    account is approved — feel free to close this
                                    tab and come back later.
                                </p>
                            </div>
                        </div>
                        <Button asChild variant="outline" className="w-full">
                            <Link to="/login">Back to sign in</Link>
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Create your account</CardTitle>
                    <CardDescription>
                        Start managing projects in under a minute
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="name">Name</Label>
                            <Input id="name" {...register('name')} />
                            {errors.name && (
                                <p className="text-xs text-destructive">
                                    {errors.name.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                                id="email"
                                type="email"
                                autoComplete="email"
                                {...register('email')}
                            />
                            {errors.email && (
                                <p className="text-xs text-destructive">
                                    {errors.email.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password">Password</Label>
                            <Input
                                id="password"
                                type="password"
                                autoComplete="new-password"
                                {...register('password')}
                            />
                            {errors.password && (
                                <p className="text-xs text-destructive">
                                    {errors.password.message}
                                </p>
                            )}
                        </div>
                        <Button type="submit" className="w-full" disabled={submitting}>
                            {submitting ? 'Creating...' : 'Create account'}
                        </Button>
                        <p className="text-center text-xs text-muted-foreground">
                            New accounts are reviewed by an administrator before access
                            is granted.
                        </p>
                        <p className="text-center text-sm text-muted-foreground">
                            Already have an account?{' '}
                            <Link
                                to="/login"
                                className="font-medium text-primary hover:underline"
                            >
                                Sign in
                            </Link>
                        </p>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
