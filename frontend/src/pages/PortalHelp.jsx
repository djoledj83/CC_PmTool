// Help for portal (requester) accounts — /portal/help. Plain-language
// guide to raising and following requests. Kept separate from the
// workspace Help (which portal accounts can't open) and written for
// customers, so it only describes what they can actually do.
import { Link } from 'react-router-dom';
import {
    ArrowLeft,
    Bell,
    CircleDot,
    Eye,
    FilePlus2,
    LifeBuoy,
    ListChecks,
    MessageSquare,
    UserCircle,
} from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

const STATUS_ROWS = [
    {
        label: 'New',
        tone: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200',
        text: 'Received and waiting for someone on the support team to pick it up. You can still edit or delete it.',
    },
    {
        label: 'In progress',
        tone: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200',
        text: 'Someone is working on it — the request shows who is handling it.',
    },
    {
        label: 'Pending',
        tone: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
        text: 'Waiting — often for an answer or information from you. Reply in the conversation to move it forward.',
    },
    {
        label: 'Resolved',
        tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200',
        text: 'The team believes it’s fixed. Not fixed? Just reply — that reopens it. If the request says “closes automatically in …”, it closes by itself after that time unless you reply.',
    },
    {
        label: 'Closed',
        tone: 'bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200',
        text: 'Finished and locked — no more replies. If the problem comes back, raise a new request and mention the old code (e.g. TKT-0042).',
    },
];

function Section({ id, icon: Icon, title, children }) {
    return (
        <section
            id={id}
            className="scroll-mt-6 rounded-lg border bg-background p-5 shadow-sm"
        >
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                </span>
                {title}
            </h2>
            <div className="space-y-2 text-sm leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
                {children}
            </div>
        </section>
    );
}

export default function PortalHelp() {
    const { user } = useAuth();
    const customer = Boolean(user?.external);

    const sections = [
        { id: 'raise', label: 'Raising a request' },
        { id: 'find', label: 'Finding your requests' },
        { id: 'request', label: 'Inside a request' },
        { id: 'statuses', label: 'What the statuses mean' },
        { id: 'visibility', label: 'Who can see your requests' },
        { id: 'notifications', label: 'Notifications' },
        { id: 'profile', label: 'Your profile & password' },
    ];

    return (
        <div className="mx-auto w-full max-w-5xl">
            <Link
                to="/portal"
                className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" /> Back to your requests
            </Link>
            <div className="mb-6">
                <h1 className="flex items-center gap-2 text-xl font-semibold">
                    <LifeBuoy className="h-5 w-5 text-primary" />
                    Help
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    How to raise a request, follow it and get the fastest
                    answer from the support team.
                </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
                <nav aria-label="On this page" className="hidden lg:block">
                    <ul className="sticky top-6 space-y-1 text-sm">
                        {sections.map((s) => (
                            <li key={s.id}>
                                <a
                                    href={`#${s.id}`}
                                    className="block rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                    {s.label}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>

                <div className="space-y-4">
                    <Section id="raise" icon={FilePlus2} title="Raising a request">
                        <p>
                            On the home page, pick the card that matches your
                            problem. Only the request types available to{' '}
                            {customer ? 'your organisation' : 'you'} are
                            shown — if you don’t see the one you need, ask your
                            administrator.
                        </p>
                        <ul className="ml-5 list-disc space-y-1">
                            <li>
                                Give it a short <strong>title</strong>, choose a{' '}
                                <strong>category</strong> (incident, request,
                                question, problem) and how{' '}
                                <strong>urgent</strong> it is.
                            </li>
                            <li>
                                In the <strong>description</strong>, say what
                                happened, when, and what you expected. You can
                                format text, add links and paste screenshots
                                straight in.
                            </li>
                            <li>
                                Fill in the extra fields of that request type —
                                the ones marked * are required.
                            </li>
                            <li>
                                <strong>Attachments</strong>: drop files or
                                screenshots — they help a lot.
                            </li>
                            <li>
                                <strong>Share with</strong>: add{' '}
                                {customer ? 'colleagues from your organisation' : 'colleagues'}{' '}
                                (or a whole group) so they can follow along and
                                reply.
                            </li>
                            <li>
                                The panel on the right has{' '}
                                <strong>tips for a good ticket</strong>, useful
                                links and — when something is really urgent —
                                who to <strong>contact directly</strong>.
                            </li>
                        </ul>
                    </Section>

                    <Section id="find" icon={ListChecks} title="Finding your requests">
                        <ul className="ml-5 list-disc space-y-1">
                            <li>
                                <strong>All</strong> shows every request you can
                                see, <strong>Mine</strong> only the ones you
                                raised, <strong>Pinned</strong> the ones you
                                pinned (use the pin on a card to keep a request
                                handy).
                            </li>
                            <li>
                                By default you see <strong>open requests</strong>{' '}
                                — switch the status filter to see resolved or
                                closed ones. Search by title or code.
                            </li>
                            <li>
                                Choose a <strong>list</strong>,{' '}
                                <strong>grid</strong> or{' '}
                                <strong>board</strong> (one column per status)
                                view. Everything updates live.
                            </li>
                            <li>
                                <strong>Statistics</strong> shows your open and
                                resolved requests and how long they took — click
                                a number to jump to those requests.
                            </li>
                        </ul>
                    </Section>

                    <Section id="request" icon={MessageSquare} title="Inside a request">
                        <ul className="ml-5 list-disc space-y-1">
                            <li>
                                Talk to the support team in the{' '}
                                <strong>conversation</strong>. Your messages are
                                on the right; <kbd className="rounded border px-1 text-[11px]">Ctrl</kbd>
                                {' + '}
                                <kbd className="rounded border px-1 text-[11px]">Enter</kbd>{' '}
                                sends. “Seen” tells you the team has read your
                                latest message.
                            </li>
                            <li>
                                Add files any time with{' '}
                                <strong>Attachments</strong> (until the request
                                is closed).
                            </li>
                            <li>
                                Until someone picks it up you can{' '}
                                <strong>Edit</strong> the title, description and
                                priority, or <strong>Delete</strong> the request.
                            </li>
                            <li>
                                <strong>People</strong>: add more colleagues or
                                a group with <em>Add</em>.
                            </li>
                        </ul>
                    </Section>

                    <Section id="statuses" icon={CircleDot} title="What the statuses mean">
                        <ul className="space-y-2">
                            {STATUS_ROWS.map((s) => (
                                <li key={s.label} className="flex items-start gap-3">
                                    <span
                                        className={cn(
                                            'mt-0.5 w-32 shrink-0 rounded px-2 py-0.5 text-center text-xs font-medium',
                                            s.tone,
                                        )}
                                    >
                                        {s.label}
                                    </span>
                                    <span>{s.text}</span>
                                </li>
                            ))}
                        </ul>
                    </Section>

                    <Section id="visibility" icon={Eye} title="Who can see your requests">
                        <ul className="ml-5 list-disc space-y-1">
                            <li>The support team handling requests.</li>
                            {customer ? (
                                <li>
                                    Colleagues from{' '}
                                    <strong>your organisation</strong> — and you
                                    see theirs. Other organisations never see
                                    your requests.
                                </li>
                            ) : (
                                <li>
                                    Other employees using the portal — the
                                    request list is shared.
                                </li>
                            )}
                            <li>
                                Anyone you add to a request, or that the
                                support team shares it with.
                            </li>
                            <li>
                                The team’s internal notes stay internal — you
                                only see the conversation meant for you.
                            </li>
                        </ul>
                    </Section>

                    <Section id="notifications" icon={Bell} title="Notifications">
                        <p>
                            The <strong>bell</strong> lights up when the team
                            replies, someone starts handling your request, it
                            goes pending, resolved or closed (or is reopened),
                            or you’re added to a request — click an item to
                            open it. You also get these by e-mail unless you
                            switch e-mail notifications off in your profile.
                        </p>
                        <p>
                            Important <strong>announcements</strong> from the
                            team pop up when you open the portal; some ask you
                            to confirm you’ve read them.
                        </p>
                    </Section>

                    <Section id="profile" icon={UserCircle} title="Your profile & password">
                        <p>
                            Click your <strong>name</strong> at the top right
                            to add a picture, phone number, position, country
                            and a few words about you, and to change your{' '}
                            <strong>password</strong>. Your e-mail address is
                            how you sign in — ask your administrator if it
                            needs to change.
                        </p>
                        <p>
                            Forgot your password? Use <em>Forgot password</em>{' '}
                            on the sign-in page; the e-mailed link works for an
                            hour.
                        </p>
                    </Section>
                </div>
            </div>
        </div>
    );
}
