import { useState } from 'react';
import { Link } from 'react-router-dom';
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

const schema = z.object({
    email: z.string().email('Enter a valid email'),
});

export default function ForgotPassword() {
    const [submitting, setSubmitting] = useState(false);
    const [resetUrl, setResetUrl] = useState(null);
    const [submitted, setSubmitted] = useState(false);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm({ resolver: zodResolver(schema) });

    const onSubmit = async ({ email }) => {
        setSubmitting(true);
        try {
            const { data } = await api.post('/auth/forgot-password', { email });
            setSubmitted(true);
            // In dev the API returns the link directly; in prod this would just be emailed.
            if (data?.resetUrl) setResetUrl(data.resetUrl);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Something went wrong');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Forgot password</CardTitle>
                    <CardDescription>
                        Enter your account email and we&apos;ll send you a reset link.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {submitted ? (
                        <div className="space-y-4 text-sm">
                            <p>
                                If an account exists for that email, a reset link has
                                been generated.
                            </p>
                            {resetUrl && (
                                <div className="space-y-2">
                                    <p className="text-muted-foreground">
                                        Dev mode: open this link to set a new password.
                                    </p>
                                    <a
                                        href={resetUrl}
                                        className="block break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs text-primary hover:underline"
                                    >
                                        {resetUrl}
                                    </a>
                                </div>
                            )}
                            <Button asChild variant="outline" className="w-full">
                                <Link to="/login">Back to sign in</Link>
                            </Button>
                        </div>
                    ) : (
                        <form
                            onSubmit={handleSubmit(onSubmit)}
                            className="space-y-4"
                        >
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
                            <Button
                                type="submit"
                                className="w-full"
                                disabled={submitting}
                            >
                                {submitting ? 'Sending...' : 'Send reset link'}
                            </Button>
                            <p className="text-center text-sm text-muted-foreground">
                                Remembered it?{' '}
                                <Link
                                    to="/login"
                                    className="font-medium text-primary hover:underline"
                                >
                                    Sign in
                                </Link>
                            </p>
                        </form>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
