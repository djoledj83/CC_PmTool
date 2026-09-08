import { Bell, BellOff, Volume2 } from 'lucide-react';

import { CHAT_SOUND_PRESETS, primeAudio, previewChatSound } from '@/lib/notificationSound';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

/**
 * Chat notification sound picker + optional mute toggle.
 * Changing the sound saves it as the user's default and plays a preview.
 */
export function ChatSoundSelect({
    soundId,
    onSoundChange,
    muted,
    onMuteToggle,
    compact = false,
    className,
}) {
    const handleSoundChange = (nextId) => {
        const saved = onSoundChange(nextId);
        primeAudio();
        previewChatSound(saved ?? nextId);
    };

    return (
        <div className={className ?? 'flex flex-wrap items-center gap-2'}>
            <Select
                value={soundId}
                onValueChange={handleSoundChange}
                disabled={muted}
            >
                <SelectTrigger
                    className={
                        compact
                            ? 'h-8 w-[min(160px,42vw)] text-xs'
                            : 'h-9 w-[200px] text-sm'
                    }
                    aria-label="Chat notification sound"
                >
                    <Volume2 className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="Sound" />
                </SelectTrigger>
                <SelectContent align="end">
                    {CHAT_SOUND_PRESETS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                            {p.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {onMuteToggle != null && (
                <Button
                    type="button"
                    size={compact ? 'icon' : 'sm'}
                    variant="outline"
                    className={compact ? 'h-8 w-8 shrink-0' : 'gap-2'}
                    onClick={onMuteToggle}
                    title={muted ? 'Unmute chat sound' : 'Mute chat sound'}
                    aria-label={muted ? 'Unmute chat sound' : 'Mute chat sound'}
                >
                    {muted ? (
                        <BellOff className="h-4 w-4" />
                    ) : (
                        <Bell className="h-4 w-4" />
                    )}
                    {!compact && (muted ? 'Unmute' : 'Mute')}
                </Button>
            )}
        </div>
    );
}
