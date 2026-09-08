import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { api } from '@/lib/api';
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

const schema = z
    .object({
        password: z.string().min(8, 'Min 8 characters'),
        confirm: z.string().min(1, 'Confirm your password'),
    })
    .refine((d) => d.password === d.confirm, {
        path: ['confirm'],
        message: "Passwords don't match",
    });

export default function ResetPassword() {
    const [params] = useSearchParams();
    const token = params.get('token') || '';
    const navigate = useNavigate();
    const [submitting, setSubmitting] = useState(false);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm({ resolver: zodResolver(schema) });

    const onSubmit = async ({ password }) => {
        if (!token) {
            toast.error('Reset token is missing from the URL');
            return;
        }
        setSubmitting(true);
        try {
            await api.post('/auth/reset-password', { token, password });
            toast.success('Password updated. You can sign in now.');
            navigate('/login', { replace: true });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Reset failed');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Set a new password</CardTitle>
                    <CardDescription>
                        Choose a strong password for your account.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {!token ? (
                        <div className="space-y-4 text-sm">
                            <p className="text-destructive">
                                Missing or invalid reset link.
                            </p>
                            <Button asChild variant="outline" className="w-full">
                                <Link to="/forgot-password">Request a new link</Link>
                            </Button>
                        </div>
                    ) : (
                        <form
                            onSubmit={handleSubmit(onSubmit)}
                            className="space-y-4"
                        >
                            <div className="space-y-2">
                                <Label htmlFor="password">New password</Label>
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
                            <div className="space-y-2">
                                <Label htmlFor="confirm">Confirm password</Label>
                                <Input
                                    id="confirm"
                                    type="password"
                                    autoComplete="new-password"
                                    {...register('confirm')}
                                />
                                {errors.confirm && (
                                    <p className="text-xs text-destructive">
                                        {errors.confirm.message}
                                    </p>
                                )}
                            </div>
                            <Button
                                type="submit"
                                className="w-full"
                                disabled={submitting}
                            >
                                {submitting ? 'Saving...' : 'Update password'}
                            </Button>
                        </form>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
