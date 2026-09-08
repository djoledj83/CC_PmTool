import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

// `Sheet` is a slide-in panel built on Radix Dialog primitives — same
// API as `Dialog`, just docked to a side instead of centred. Used for
// the mobile sidebar drawer, the mobile filter sheet, etc.

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            className,
        )}
        {...props}
    />
));
SheetOverlay.displayName = 'SheetOverlay';

const SIDE_CLASSES = {
    left: 'left-0 top-0 h-full w-3/4 max-w-xs border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
    right: 'right-0 top-0 h-full w-3/4 max-w-xs border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
    top: 'inset-x-0 top-0 border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
    bottom: 'inset-x-0 bottom-0 border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom max-h-[85vh] rounded-t-lg',
};

const SheetContent = React.forwardRef(
    ({ side = 'right', className, children, hideClose = false, ...props }, ref) => (
        <SheetPortal>
            <SheetOverlay />
            <DialogPrimitive.Content
                ref={ref}
                className={cn(
                    'fixed z-50 flex flex-col gap-4 bg-background p-4 shadow-xl transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-150 data-[state=open]:duration-200',
                    SIDE_CLASSES[side],
                    className,
                )}
                {...props}
            >
                {children}
                {!hideClose && (
                    <DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
                        <X className="h-4 w-4" />
                        <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
                )}
            </DialogPrimitive.Content>
        </SheetPortal>
    ),
);
SheetContent.displayName = 'SheetContent';

const SheetHeader = ({ className, ...props }) => (
    <div
        className={cn(
            'flex flex-col gap-1 border-b pb-3 text-left',
            className,
        )}
        {...props}
    />
);

const SheetFooter = ({ className, ...props }) => (
    <div
        className={cn(
            'mt-auto flex flex-col gap-2 border-t pt-3 sm:flex-row sm:justify-end',
            className,
        )}
        {...props}
    />
);

const SheetTitle = React.forwardRef(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn('text-base font-semibold', className)}
        {...props}
    />
));
SheetTitle.displayName = 'SheetTitle';

const SheetDescription = React.forwardRef(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn('text-xs text-muted-foreground', className)}
        {...props}
    />
));
SheetDescription.displayName = 'SheetDescription';

export {
    Sheet,
    SheetTrigger,
    SheetClose,
    SheetPortal,
    SheetOverlay,
    SheetContent,
    SheetHeader,
    SheetFooter,
    SheetTitle,
    SheetDescription,
};
