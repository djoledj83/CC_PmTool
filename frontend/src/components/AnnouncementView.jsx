// Shared presentational view for a broadcast announcement — the centered
// icon-circle, type label, title and body. Used by both the live
// AnnouncementModal and the admin preview so they look identical. Always
// rendered inside a <DialogContent>; it emits the accessible <DialogTitle>.
import { AlertCircle, Info, Lightbulb, ExternalLink } from 'lucide-react';

import { DialogTitle } from '@/components/ui/dialog';
import { RichText } from '@/components/RichText';

export const ANNOUNCEMENT_TYPE_META = {
    IMPORTANT: {
        label: 'Important',
        ring: 'border-red-500/30',
        bg: 'bg-red-100 dark:bg-red-500/15',
        fg: 'text-red-600 dark:text-red-500',
        Icon: AlertCircle,
    },
    INFO: {
        label: 'Information',
        ring: 'border-emerald-500/30',
        bg: 'bg-emerald-100 dark:bg-emerald-500/15',
        fg: 'text-emerald-600 dark:text-emerald-500',
        Icon: Info,
    },
    TIP: {
        label: 'Good to know',
        ring: 'border-amber-500/30',
        bg: 'bg-amber-100 dark:bg-amber-500/15',
        fg: 'text-amber-600 dark:text-amber-500',
        Icon: Lightbulb,
    },
    MANDATORY: {
        label: 'Service moved',
        ring: 'border-blue-500/30',
        bg: 'bg-blue-100 dark:bg-blue-500/15',
        fg: 'text-blue-600 dark:text-blue-500',
        Icon: ExternalLink,
    },
};

export default function AnnouncementView({ type, title, body, plainTitle = false }) {
    const meta = ANNOUNCEMENT_TYPE_META[type] || ANNOUNCEMENT_TYPE_META.INFO;
    const { Icon } = meta;
    const titleClass = `text-2xl font-bold leading-snug ${meta.fg}`;
    return (
        <>
            <div
                className={`flex h-20 w-20 items-center justify-center rounded-full border-4 ${meta.ring} ${meta.bg}`}
            >
                <Icon className={`h-12 w-12 ${meta.fg}`} />
            </div>

            {/* The admin-defined title, tinted with the type's colour. The
                type name itself (Important / Information / Good to know) is
                only shown as the icon's explanation in the admin composer.
                `plainTitle` renders a bare heading for use outside a Dialog
                (the blocking migration overlay isn't a Radix Dialog). */}
            {plainTitle ? (
                <h2 className={titleClass}>{title}</h2>
            ) : (
                <DialogTitle className={titleClass}>{title}</DialogTitle>
            )}

            <div className="max-h-[45vh] w-full overflow-y-auto text-left text-[15px] leading-relaxed text-foreground">
                <RichText source={body} />
            </div>
        </>
    );
}
