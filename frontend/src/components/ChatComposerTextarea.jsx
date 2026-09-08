import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react';

import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MIN_HEIGHT_PX = 44;
const DEFAULT_MAX_MULTIPLIER = 4;

/**
 * Chat message composer: grows with content up to
 * `maxHeightMultiplier` × its initial single-line height, then scrolls
 * internally (vertical scrollbar on the right).
 */
export const ChatComposerTextarea = forwardRef(function ChatComposerTextarea(
    {
        value,
        onChange,
        maxHeightMultiplier = DEFAULT_MAX_MULTIPLIER,
        className,
        onInput,
        ...rest
    },
    ref,
) {
    const innerRef = useRef(null);
    const baseHeightRef = useRef(null);

    useImperativeHandle(ref, () => innerRef.current);

    const measureBaseHeight = useCallback(() => {
        const el = innerRef.current;
        if (!el) return MIN_HEIGHT_PX;
        const prev = el.style.height;
        el.style.height = 'auto';
        const h = Math.max(MIN_HEIGHT_PX, el.scrollHeight);
        el.style.height = prev;
        return h;
    }, []);

    const resize = useCallback(() => {
        const el = innerRef.current;
        if (!el) return;
        if (!baseHeightRef.current) {
            baseHeightRef.current = measureBaseHeight();
        }
        const multiplier = Math.max(1, maxHeightMultiplier);
        const maxPx = Math.round(baseHeightRef.current * multiplier);

        el.style.height = 'auto';
        const contentHeight = el.scrollHeight;
        const next = Math.min(contentHeight, maxPx);
        el.style.height = `${Math.max(baseHeightRef.current, next)}px`;
        el.style.overflowY = contentHeight > maxPx ? 'auto' : 'hidden';
    }, [maxHeightMultiplier, measureBaseHeight]);

    useLayoutEffect(() => {
        baseHeightRef.current = measureBaseHeight();
        resize();
    }, [measureBaseHeight, resize]);

    useLayoutEffect(() => {
        resize();
    }, [value, resize]);

    return (
        <Textarea
            ref={innerRef}
            rows={1}
            value={value}
            onChange={(e) => {
                onChange?.(e);
                resize();
            }}
            onInput={(e) => {
                onInput?.(e);
                resize();
            }}
            className={cn('resize-none', className)}
            style={{ minHeight: MIN_HEIGHT_PX }}
            {...rest}
        />
    );
});
