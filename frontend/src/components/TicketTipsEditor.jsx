// Edits a list of "Tips for a good ticket" — one short line each: add,
// remove, move up / down (Enter in a tip adds the next one). Used in a
// ticket type's help panel (Templates → Ticket types → Edit → Help panel).
import { useRef } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MAX_TIPS, MAX_TIP_LENGTH } from '@/components/RaiseTicketParts';

export function TicketTipsEditor({
    value,
    onChange,
    disabled = false,
    // Extra buttons next to "Add tip" (e.g. "Use the built-in tips").
    actions = null,
    emptyText = 'No tips yet.',
    placeholder = 'e.g. Include the terminal ID (TID)',
}) {
    const list = Array.isArray(value) ? value : [];
    // Index of the input to focus after the next render (a tip just added).
    const focusNext = useRef(null);

    const update = (next) => onChange?.(next);
    const insertAt = (i) => {
        if (list.length >= MAX_TIPS) return;
        focusNext.current = i;
        update([...list.slice(0, i), '', ...list.slice(i)]);
    };
    const move = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= list.length) return;
        const next = [...list];
        [next[i], next[j]] = [next[j], next[i]];
        update(next);
    };

    return (
        <div className="space-y-2" data-tips-editor="">
            {list.length === 0 && emptyText && (
                <p className="text-xs text-muted-foreground">{emptyText}</p>
            )}
            {list.map((tip, i) => (
                <div key={i} className="flex items-center gap-1">
                    <CheckCircle2 className="mr-1 h-4 w-4 shrink-0 text-primary" />
                    <Input
                        ref={(el) => {
                            if (el && focusNext.current === i) {
                                focusNext.current = null;
                                el.focus();
                            }
                        }}
                        value={tip}
                        onChange={(e) =>
                            update(list.map((t, idx) => (idx === i ? e.target.value : t)))
                        }
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                insertAt(i + 1);
                            }
                        }}
                        maxLength={MAX_TIP_LENGTH}
                        placeholder={placeholder}
                        aria-label={`Tip ${i + 1}`}
                        disabled={disabled}
                        className="h-9"
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground"
                        onClick={() => move(i, -1)}
                        disabled={disabled || i === 0}
                        aria-label={`Move tip ${i + 1} up`}
                    >
                        <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground"
                        onClick={() => move(i, 1)}
                        disabled={disabled || i === list.length - 1}
                        aria-label={`Move tip ${i + 1} down`}
                    >
                        <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-rose-600"
                        onClick={() => update(list.filter((_, idx) => idx !== i))}
                        disabled={disabled}
                        aria-label={`Remove tip ${i + 1}`}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={disabled || list.length >= MAX_TIPS}
                    onClick={() => insertAt(list.length)}
                >
                    <Plus className="h-4 w-4" /> Add tip
                </Button>
                {actions}
                <span className="ml-auto text-[11px] text-muted-foreground">
                    {list.length}/{MAX_TIPS}
                </span>
            </div>
        </div>
    );
}

export default TicketTipsEditor;
