import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, FolderKanban, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';

const schema = z.object({
    name: z.string().min(1, 'Name is required').max(150),
    description: z.string().max(2000).optional(),
});

export default function Dashboard() {
    const [projects, setProjects] = useState([]);
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const {
        register,
        handleSubmit,
        reset,
        formState: { errors },
    } = useForm({ resolver: zodResolver(schema) });

    const load = async () => {
        try {
            const { data } = await api.get('/projects');
            setProjects(data.projects);
        } catch (err) {
            toast.error('Failed to load projects');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const onCreate = async (values) => {
        setSubmitting(true);
        try {
            await api.post('/projects', values);
            toast.success('Project created');
            reset();
            setOpen(false);
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not create project');
        } finally {
            setSubmitting(false);
        }
    };

    const onDelete = async (id) => {
        if (!window.confirm('Delete this project and all its tasks?')) return;
        try {
            await api.delete(`/projects/${id}`);
            toast.success('Project deleted');
            load();
        } catch (err) {
            toast.error('Could not delete project');
        }
    };

    return (
        <div className="container py-8">
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
                    <p className="text-muted-foreground">
                        All your projects in one place
                    </p>
                </div>
                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogTrigger asChild>
                        <Button className="gap-2">
                            <Plus className="h-4 w-4" />
                            New project
                        </Button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Create a project</DialogTitle>
                            <DialogDescription>
                                Give it a name and an optional description.
                            </DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleSubmit(onCreate)} className="space-y-4">
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
                                <Label htmlFor="description">Description</Label>
                                <Textarea
                                    id="description"
                                    rows={4}
                                    {...register('description')}
                                />
                            </div>
                            <DialogFooter>
                                <Button type="submit" disabled={submitting}>
                                    {submitting ? 'Creating...' : 'Create'}
                                </Button>
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>

            {loading ? (
                <p className="text-muted-foreground">Loading projects...</p>
            ) : projects.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <FolderKanban className="h-10 w-10 text-muted-foreground" />
                        <div>
                            <p className="font-medium">No projects yet</p>
                            <p className="text-sm text-muted-foreground">
                                Create your first project to get started.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {projects.map((project) => (
                        <Card key={project.id} className="flex flex-col">
                            <CardHeader>
                                <div className="flex items-start justify-between gap-2">
                                    <CardTitle className="line-clamp-1 text-lg">
                                        {project.name}
                                    </CardTitle>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => onDelete(project.id)}
                                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                                {project.description && (
                                    <CardDescription className="line-clamp-2">
                                        {project.description}
                                    </CardDescription>
                                )}
                            </CardHeader>
                            <CardContent className="mt-auto flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">
                                    {project._count.tasks} task
                                    {project._count.tasks === 1 ? '' : 's'}
                                </span>
                                <Button asChild variant="outline" size="sm">
                                    <Link to={`/projects/${project.id}`}>Open</Link>
                                </Button>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
