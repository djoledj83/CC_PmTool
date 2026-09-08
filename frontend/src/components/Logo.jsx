// Brand logo that swaps its light-/dark-background artwork with the theme.
//
// It relies on Tailwind's `dark:` variant, which keys off the `dark` class
// the theme system puts on <html> — Dark, Dim and system-dark all set it —
// so light / dark / dim / system all work with zero JavaScript. Both images
// are rendered; CSS shows exactly one.
//
//   variant="full" (default) → icon + wordmark lockup (desktop_* files)
//   variant="icon"           → the mark only (icon_* files, square)
import { cn } from '@/lib/utils';
import { APP_NAME } from '@/lib/appInfo';

import logoFullLight from '@/assets/logo_desktop_light_background.svg';
import logoFullDark from '@/assets/logo_desktop_dark_background.svg';
import logoIconLight from '@/assets/logo_icon_light_background.svg';
import logoIconDark from '@/assets/logo_icon_dark_background.svg';

export function Logo({ variant = 'full', className, alt = APP_NAME }) {
    const lightSrc = variant === 'icon' ? logoIconLight : logoFullLight;
    const darkSrc = variant === 'icon' ? logoIconDark : logoFullDark;
    return (
        <>
            {/* Shown on light backgrounds (no `dark` class). */}
            <img
                src={lightSrc}
                alt={alt}
                className={cn('block dark:hidden', className)}
                draggable="false"
            />
            {/* Shown on dark / dim backgrounds. Decorative duplicate → no alt. */}
            <img
                src={darkSrc}
                alt=""
                aria-hidden="true"
                className={cn('hidden dark:block', className)}
                draggable="false"
            />
        </>
    );
}

export default Logo;
