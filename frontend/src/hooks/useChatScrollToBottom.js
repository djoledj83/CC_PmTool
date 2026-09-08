import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Keeps the chat message list scrolled to the latest message.
 * Returns a ref for the overflow-y-auto container (not a sentinel div).
 *
 * - Opening a thread or loading history: instant jump to bottom.
 * - New messages while already in the thread: smooth scroll.
 */
export function useChatScrollToBottom({ messages, ready = true, resetKey }) {
    const scrollRef = useRef(null);
    const prevLenRef = useRef(0);

    useEffect(() => {
        prevLenRef.current = 0;
    }, [resetKey]);

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el || !ready) return;

        const len = Array.isArray(messages) ? messages.length : 0;
        const grew = prevLenRef.current > 0 && len > prevLenRef.current;
        prevLenRef.current = len;

        const scroll = () => {
            if (grew && el.scrollTo) {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            } else {
                el.scrollTop = el.scrollHeight;
            }
        };

        requestAnimationFrame(() => {
            requestAnimationFrame(scroll);
        });
    }, [messages, ready, resetKey]);

    return scrollRef;
}
