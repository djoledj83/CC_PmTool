// Big-screen ticket board — /wallboard/:key. Opens WITHOUT signing in: the
// secret key in the link (created under Templates → Tickets → Wallboards)
// is the credential. Shows every open, non-internal ticket by status with a
// few counters, updates live, and announces a new ticket with a big pop-up
// card, a chime and a glow in its column. Built for a TV: dark, large
// type, no scrolling, keeps the screen awake.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import {
    BellRing,
    CheckCircle2,
    Flame,
    Inbox,
    LifeBuoy,
    Link2Off,
    Maximize,
    Sparkles,
    UserCheck,
    UserX,
    Volume2,
    VolumeX,
    WifiOff,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { getTicketTypeChipClasses } from '@/lib/ticketTypeColors';
import { getTicketTypeIcon } from '@/lib/ticketTypeIcons';
import {
    audioReady,
    installAudioGestureUnlock,
    playWallboardChime,
    primeAudio,
} from '@/lib/notificationSound';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const COLUMNS = [
    { status: 'NEW', label: 'New', dot: 'bg-sky-400' },
    { status: 'IN_PROGRESS', label: 'In progress', dot: 'bg-indigo-400' },
    { status: 'PENDING', label: 'Pending', dot: 'bg-amber-400' },
];
const PRIORITY = {
    URGENT: { label: 'Urgent', className: 'bg-red-500 text-white' },
    HIGH: { label: 'High', className: 'bg-amber-400 text-slate-950' },
    NORMAL: { label: 'Normal', className: 'bg-slate-700 text-slate-200' },
    LOW: { label: 'Low', className: 'bg-slate-800 text-slate-400' },
};
const CATEGORY = { INCIDENT: 'Incident', REQUEST: 'Request', QUESTION: 'Question', PROBLEM: 'Problem' };

// Live pings make updates instant; polling is the safety net — every
// minute while the live link works, every 10 s while it doesn't.
const POLL_MS = 60 * 1000;
const FALLBACK_POLL_MS = 10 * 1000;
const POPUP_MS = 10 * 1000;
const FLASH_MS = 60 * 1000;
const FRESH_MS = 15 * 60 * 1000; // appeared + younger than this = new ticket
const MAX_PER_COLUMN = 40; // rendered; what doesn't fit is counted as "+N more"
const MORE_RESERVE = 40; // px kept free for the "+N more" line
const MUTE_KEY = 'wallboard:muted';

const localMidnight = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
};

export function ticketAge(createdAt, now = Date.now()) {
    const mins = Math.floor((now - new Date(createdAt).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}

const readMuted = () => {
    try {
        return window.localStorage.getItem(MUTE_KEY) === '1';
    } catch {
        return false;
    }
};

function TypeChip({ type, large = false }) {
    if (!type) return null;
    const Icon = getTicketTypeIcon(type.icon);
    return (
        <span
            className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-md font-medium',
                large ? 'px-3 py-1.5 text-xl' : 'px-2 py-0.5 text-sm',
                getTicketTypeChipClasses(type.color),
            )}
        >
            <Icon className={large ? 'h-6 w-6' : 'h-4 w-4'} />
            <span className="truncate">{type.name}</span>
        </span>
    );
}

function PriorityBadge({ priority, large = false, always = false }) {
    const p = PRIORITY[priority];
    if (!p || (!always && priority !== 'URGENT' && priority !== 'HIGH')) return null;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-md font-semibold uppercase tracking-wide',
                large ? 'px-3 py-1.5 text-lg' : 'px-2 py-0.5 text-xs',
                p.className,
            )}
        >
            {priority === 'URGENT' && <Flame className={large ? 'h-5 w-5' : 'h-3.5 w-3.5'} />}
            {p.label}
        </span>
    );
}

function Counter({ icon: Icon, label, value, tone = 'default' }) {
    const tones = {
        default: 'text-slate-50',
        sky: 'text-sky-300',
        amber: 'text-amber-300',
        red: 'text-red-400',
        emerald: 'text-emerald-300',
    };
    return (
        <div className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 px-5 py-3">
            <Icon className={cn('h-8 w-8 shrink-0', tones[tone])} />
            <div className="min-w-0">
                <div className={cn('text-4xl font-bold leading-none tabular-nums', tones[tone])}>
                    {value}
                </div>
                <div className="mt-1 truncate text-sm font-medium uppercase tracking-wide text-slate-400">
                    {label}
                </div>
            </div>
        </div>
    );
}

function TicketTile({ t, now, flashing, hidden }) {
    return (
        <div
            data-code={t.code}
            aria-hidden={hidden || undefined}
            className={cn(
                'shrink-0 rounded-xl border border-slate-800 bg-slate-900 p-3 transition-colors',
                hidden && 'invisible',
                !t.handler && 'border-l-4 border-l-amber-400',
                t.priority === 'URGENT' && 'border-red-500/60',
                flashing && 'wb-flash',
            )}
        >
            <div className="flex items-center justify-between gap-2 text-base text-slate-400">
                <span className="font-mono font-semibold text-slate-300">{t.code}</span>
                <span className="tabular-nums">{ticketAge(t.createdAt, now)}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-xl font-semibold leading-snug text-slate-50">
                {t.title}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <TypeChip type={t.requestType} />
                <PriorityBadge priority={t.priority} />
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-base">
                {t.handler ? (
                    <>
                        <UserCheck className="h-4 w-4 text-emerald-400" />
                        <span className="truncate text-slate-300">{t.handler}</span>
                    </>
                ) : (
                    <>
                        <UserX className="h-4 w-4 text-amber-300" />
                        <span className="font-medium text-amber-300">Unassigned</span>
                    </>
                )}
            </div>
        </div>
    );
}

function NewTicketPopup({ ticket, more, onDismiss }) {
    return (
        <div
            role="alertdialog"
            aria-label={`New ticket ${ticket.code}`}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-10 backdrop-blur-sm"
            onClick={onDismiss}
        >
            <div className="wb-pop w-full max-w-4xl overflow-hidden rounded-3xl border-2 border-sky-400 bg-slate-900 shadow-2xl shadow-sky-500/20">
                <div className="p-10">
                    <div className="flex items-center justify-between gap-4">
                        <span className="inline-flex items-center gap-3 text-2xl font-bold uppercase tracking-widest text-sky-300">
                            <BellRing className="wb-ring h-9 w-9" />
                            New ticket
                        </span>
                        <span className="font-mono text-3xl font-semibold text-slate-300">
                            {ticket.code}
                        </span>
                    </div>
                    <div className="mt-6 text-5xl font-bold leading-tight text-white">
                        {ticket.title}
                    </div>
                    <div className="mt-8 flex flex-wrap items-center gap-3">
                        <TypeChip type={ticket.requestType} large />
                        <PriorityBadge priority={ticket.priority} large always />
                        {CATEGORY[ticket.category] && (
                            <span className="rounded-md bg-slate-800 px-3 py-1.5 text-lg text-slate-300">
                                {CATEGORY[ticket.category]}
                            </span>
                        )}
                        <span className="ml-auto text-xl text-slate-400">
                            {ticket.handler ? `Handled by ${ticket.handler}` : 'Waiting to be picked up'}
                        </span>
                    </div>
                    {more > 0 && (
                        <div className="mt-6 text-lg font-medium text-sky-300">
                            +{more} more new {more === 1 ? 'ticket' : 'tickets'}
                        </div>
                    )}
                </div>
                <div className="h-2 bg-slate-800">
                    <div
                        key={ticket.code}
                        className="wb-timer h-full bg-sky-400"
                        style={{ animationDuration: `${POPUP_MS}ms` }}
                    />
                </div>
            </div>
        </div>
    );
}

const STYLES = `
@keyframes wbGlow { 0%,100% { box-shadow: 0 0 0 0 rgba(56,189,248,0); } 50% { box-shadow: 0 0 0 5px rgba(56,189,248,.55); } }
.wb-flash { animation: wbGlow 1.4s ease-in-out infinite; border-color: rgb(56 189 248) !important; }
@keyframes wbIn { from { opacity: 0; transform: scale(.94) translateY(16px); } to { opacity: 1; transform: none; } }
.wb-pop { animation: wbIn .35s ease-out; }
@keyframes wbTimer { from { width: 100%; } to { width: 0%; } }
.wb-timer { animation-name: wbTimer; animation-timing-function: linear; animation-fill-mode: forwards; }
@keyframes wbRing { 0%,100% { transform: rotate(0); } 10%,30% { transform: rotate(-14deg); } 20%,40% { transform: rotate(14deg); } 50% { transform: rotate(0); } }
.wb-ring { animation: wbRing 1.6s ease-in-out infinite; transform-origin: top center; }
`;

export default function Wallboard() {
    const { key } = useParams();
    const [data, setData] = useState(null);
    const [state, setState] = useState('loading'); // loading | ok | invalid
    const [offline, setOffline] = useState(false);
    const [live, setLive] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [flash, setFlash] = useState({}); // code → until (ms)
    const [queue, setQueue] = useState([]); // new tickets for the pop-up
    const [muted, setMuted] = useState(readMuted);
    const [soundOn, setSoundOn] = useState(() => audioReady());
    const [fullscreen, setFullscreen] = useState(false);
    const knownRef = useRef(null); // codes seen in the previous load
    const mutedRef = useRef(muted);
    mutedRef.current = muted;

    const handleData = useCallback((json) => {
        const nowMs = Date.now();
        const known = knownRef.current;
        if (known) {
            const appeared = json.tickets.filter((t) => !known.has(t.code));
            if (appeared.length) {
                setFlash((prev) => {
                    const next = { ...prev };
                    for (const t of appeared) next[t.code] = nowMs + FLASH_MS;
                    return next;
                });
                // Pop-up + chime only for genuinely new tickets (a reopened
                // one just glows).
                const brandNew = appeared.filter(
                    (t) => nowMs - new Date(t.createdAt).getTime() < FRESH_MS,
                );
                if (brandNew.length) {
                    setQueue((q) => [...q, ...brandNew.reverse()]);
                    if (!mutedRef.current) playWallboardChime();
                }
            }
        }
        knownRef.current = new Set(json.tickets.map((t) => t.code));
        setData(json);
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await fetch(
                `${API_URL}/api/wallboard/view/${encodeURIComponent(key)}?since=${encodeURIComponent(localMidnight())}`,
                { cache: 'no-store' },
            );
            if (res.status === 404) {
                setState('invalid');
                setOffline(false);
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            handleData(await res.json());
            setState('ok');
            setOffline(false);
        } catch {
            setOffline(true);
        }
    }, [key, handleData]);

    // First load.
    useEffect(() => {
        load();
    }, [load]);

    // Backstop polling (fast while the live link is down).
    useEffect(() => {
        const id = setInterval(load, live ? POLL_MS : FALLBACK_POLL_MS);
        return () => clearInterval(id);
    }, [load, live]);

    // Live: the server pings "something changed" → refetch (debounced).
    useEffect(() => {
        const sock = io(API_URL, {
            auth: { wallboard: key },
            transports: ['websocket', 'polling'],
            reconnection: true,
        });
        let debounce = null;
        let retry = null;
        const refetch = () => {
            clearTimeout(debounce);
            debounce = setTimeout(load, 800);
        };
        sock.on('connect', () => {
            setLive(true);
            refetch();
        });
        sock.on('ticket:activity', refetch);
        sock.on('disconnect', (reason) => {
            setLive(false);
            // Link paused / regenerated / deleted → the server dropped us.
            if (reason === 'io server disconnect') {
                load();
                clearTimeout(retry);
                retry = setTimeout(() => sock.connect(), 30 * 1000);
            }
        });
        sock.on('connect_error', () => {
            setLive(false);
            // A refused key isn't retried by socket.io on its own.
            if (!sock.active) {
                clearTimeout(retry);
                retry = setTimeout(() => sock.connect(), 30 * 1000);
            }
        });
        return () => {
            clearTimeout(debounce);
            clearTimeout(retry);
            sock.disconnect();
        };
    }, [key, load]);

    // Clock + ages; expire finished glows.
    useEffect(() => {
        const id = setInterval(() => {
            const t = Date.now();
            setNow(t);
            setFlash((prev) => {
                const active = Object.entries(prev).filter(([, until]) => until > t);
                return active.length === Object.keys(prev).length ? prev : Object.fromEntries(active);
            });
            setSoundOn(audioReady());
        }, 5000);
        return () => clearInterval(id);
    }, []);

    // Pop-up: one new ticket at a time, POPUP_MS each.
    useEffect(() => {
        if (!queue.length) return undefined;
        const id = setTimeout(() => setQueue((q) => q.slice(1)), POPUP_MS);
        return () => clearTimeout(id);
    }, [queue]);

    // Sound needs one click / key press on the page (browser rule).
    useEffect(() => {
        const off = installAudioGestureUnlock();
        const onGesture = () => {
            primeAudio();
            setTimeout(() => setSoundOn(audioReady()), 300);
        };
        window.addEventListener('pointerdown', onGesture);
        window.addEventListener('keydown', onGesture);
        return () => {
            off();
            window.removeEventListener('pointerdown', onGesture);
            window.removeEventListener('keydown', onGesture);
        };
    }, []);

    // Keep the screen awake where the browser allows it.
    useEffect(() => {
        let lock = null;
        const request = async () => {
            try {
                lock = await navigator.wakeLock?.request?.('screen');
            } catch {
                /* not allowed / not supported */
            }
        };
        request();
        const onVisible = () => {
            if (document.visibilityState === 'visible') request();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            lock?.release?.().catch?.(() => {});
        };
    }, []);

    useEffect(() => {
        const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onFs);
        return () => document.removeEventListener('fullscreenchange', onFs);
    }, []);

    useEffect(() => {
        if (data?.board?.name) document.title = `${data.board.name} · Wallboard`;
    }, [data?.board?.name]);

    // The "Turn on sound" button: unlock audio and play the chime once so
    // whoever sets up the screen hears that it works.
    const enableSound = () => {
        primeAudio();
        playWallboardChime();
        setTimeout(() => setSoundOn(audioReady()), 300);
    };

    const toggleMute = () => {
        const next = !muted;
        setMuted(next);
        try {
            if (next) window.localStorage.setItem(MUTE_KEY, '1');
            else window.localStorage.removeItem(MUTE_KEY);
        } catch {
            /* ignore */
        }
        if (!next) {
            primeAudio();
            playWallboardChime();
        }
    };

    const byStatus = useMemo(() => {
        const out = Object.fromEntries(COLUMNS.map((c) => [c.status, []]));
        for (const t of data?.tickets || []) {
            if (out[t.status]) out[t.status].push(t);
        }
        return out;
    }, [data]);

    // How many tiles fit in each column (TV sizes vary): tiles that don't
    // fit are hidden and counted as "+N more".
    const boardRef = useRef(null);
    const [fit, setFit] = useState({});
    const [boardSize, setBoardSize] = useState(0);
    useEffect(() => {
        const onResize = () => setBoardSize(window.innerWidth * 100000 + window.innerHeight);
        window.addEventListener('resize', onResize);
        document.addEventListener('fullscreenchange', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
            document.removeEventListener('fullscreenchange', onResize);
        };
    }, []);
    useLayoutEffect(() => {
        const el = boardRef.current;
        if (!el) return;
        const next = {};
        for (const colEl of el.querySelectorAll('[data-list]')) {
            const tiles = [...colEl.querySelectorAll('[data-code]')];
            const room = colEl.clientHeight;
            const fitsAll = tiles.every((x) => x.offsetTop + x.offsetHeight <= room);
            const limit = fitsAll ? room : room - MORE_RESERVE;
            let n = 0;
            for (const x of tiles) {
                if (x.offsetTop + x.offsetHeight <= limit) n += 1;
                else break;
            }
            // jsdom / not laid out yet → show everything.
            next[colEl.dataset.list] = room > 0 ? n : tiles.length;
        }
        setFit((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, [data, boardSize]);

    const clock = new Date(now);

    if (state === 'invalid') {
        return (
            <div className="dark flex h-screen flex-col items-center justify-center gap-4 bg-slate-950 p-10 text-center text-slate-200">
                <Link2Off className="h-16 w-16 text-slate-500" />
                <h1 className="text-3xl font-semibold">This wallboard link isn’t valid</h1>
                <p className="max-w-xl text-lg text-slate-400">
                    It may have been paused, regenerated or deleted. Ask an
                    administrator for the current link (Templates → Tickets →
                    Wallboards). This screen checks again every minute.
                </p>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="dark flex h-screen items-center justify-center bg-slate-950 text-2xl text-slate-400">
                {offline ? 'Can’t reach the server — retrying…' : 'Loading the board…'}
            </div>
        );
    }

    const c = data.counters;
    const current = queue[0];

    return (
        <div className="dark flex h-screen flex-col gap-4 overflow-hidden bg-slate-950 p-6 text-slate-100">
            <style>{STYLES}</style>
            <header className="flex items-center justify-between gap-6">
                <div className="flex min-w-0 items-center gap-3">
                    <LifeBuoy className="h-9 w-9 shrink-0 text-sky-400" />
                    <h1 className="truncate text-3xl font-bold">{data.board.name}</h1>
                    <span
                        className={cn(
                            'ml-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium',
                            live
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-amber-500/15 text-amber-300',
                        )}
                        title={live ? 'Updates arrive instantly' : 'Live link down — refreshing every minute'}
                    >
                        <span className={cn('h-2.5 w-2.5 rounded-full', live ? 'bg-emerald-400' : 'bg-amber-400')} />
                        {live ? 'Live' : 'Reconnecting…'}
                    </span>
                </div>
                <div className="flex items-center gap-4">
                    <button
                        type="button"
                        onClick={toggleMute}
                        className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                        title={muted ? 'Sound off — click to turn on' : 'Sound on — click to mute'}
                        aria-label={muted ? 'Turn sound on' : 'Mute'}
                    >
                        {muted ? <VolumeX className="h-6 w-6" /> : <Volume2 className="h-6 w-6" />}
                    </button>
                    {!fullscreen && (
                        <button
                            type="button"
                            onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}
                            className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                            title="Full screen"
                            aria-label="Full screen"
                        >
                            <Maximize className="h-6 w-6" />
                        </button>
                    )}
                    <div className="text-right">
                        <div className="text-4xl font-bold tabular-nums leading-none">
                            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="mt-1 text-sm text-slate-400">
                            {clock.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
                        </div>
                    </div>
                </div>
            </header>

            {offline && (
                <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-amber-200">
                    <WifiOff className="h-5 w-5" />
                    Can’t reach the server — showing the last known tickets, retrying…
                </div>
            )}

            <section className="grid grid-cols-5 gap-4">
                <Counter icon={Inbox} label="Active" value={c.open} tone="sky" />
                <Counter icon={Sparkles} label="New today" value={c.newToday} />
                <Counter icon={UserX} label="Unassigned" value={c.unassigned} tone={c.unassigned > 0 ? 'amber' : 'default'} />
                <Counter icon={Flame} label="Urgent" value={c.urgent} tone={c.urgent > 0 ? 'red' : 'default'} />
                <Counter icon={CheckCircle2} label="Resolved today" value={c.resolvedToday} tone="emerald" />
            </section>

            {data.tickets.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
                    <CheckCircle2 className="h-16 w-16 text-emerald-400" />
                    <div className="text-3xl font-semibold text-slate-200">All clear</div>
                    <div className="text-lg">No open tickets right now.</div>
                </div>
            ) : (
                <section ref={boardRef} className="grid min-h-0 flex-1 grid-cols-3 gap-4">
                    {COLUMNS.map((col) => {
                        const list = byStatus[col.status];
                        const shown = list.slice(0, MAX_PER_COLUMN);
                        const fits = fit[col.status] ?? shown.length;
                        const more = list.length - Math.min(fits, shown.length);
                        return (
                            <div
                                key={col.status}
                                data-column={col.status}
                                className="flex min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/40"
                            >
                                <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                                    <span className="flex items-center gap-2 text-lg font-semibold">
                                        <span className={cn('h-3 w-3 rounded-full', col.dot)} />
                                        {col.label}
                                    </span>
                                    <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-base font-semibold tabular-nums text-slate-200">
                                        {list.length}
                                    </span>
                                </div>
                                <div
                                    data-list={col.status}
                                    className="relative flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-3"
                                >
                                    {shown.map((t, i) => (
                                        <TicketTile
                                            key={t.code}
                                            t={t}
                                            now={now}
                                            flashing={(flash[t.code] || 0) > now}
                                            hidden={i >= fits}
                                        />
                                    ))}
                                    {more > 0 && (
                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent px-3 pb-2 pt-6 text-center text-base font-semibold text-slate-300">
                                            +{more} more
                                        </div>
                                    )}
                                    {list.length === 0 && (
                                        <div className="pt-6 text-center text-slate-600">—</div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </section>
            )}

            {/* Browsers only allow sound after one click on the page. */}
            {!muted && !soundOn && (
                <button
                    type="button"
                    onClick={enableSound}
                    className="fixed bottom-6 left-1/2 z-40 inline-flex -translate-x-1/2 items-center gap-3 rounded-full bg-sky-500 px-6 py-3 text-lg font-semibold text-white shadow-2xl shadow-sky-500/30 hover:bg-sky-400"
                >
                    <Volume2 className="h-6 w-6" />
                    Turn on sound for new tickets
                </button>
            )}

            {current && (
                <NewTicketPopup
                    ticket={current}
                    more={queue.length - 1}
                    onDismiss={() => setQueue((q) => q.slice(1))}
                />
            )}
        </div>
    );
}
