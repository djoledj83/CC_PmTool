import { TopBar } from '@/components/TopBar';

export function EmptyState({ title, icon: Icon, description }) {
    return (
        <>
            <TopBar title={title} />
            <main className="flex-1 overflow-auto bg-muted/20 p-6">
                <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed bg-card p-16 text-center">
                    {Icon && <Icon className="h-10 w-10 text-muted-foreground" />}
                    <h2 className="mt-4 text-lg font-semibold">{title}</h2>
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">
                        {description ||
                            'This section is coming soon. We will build it together in the next steps.'}
                    </p>
                </div>
            </main>
        </>
    );
}
