// Predefined icon set for ticket request types. We store a short string
// key on the type (TicketRequestType.icon) and resolve it to a lucide
// component here, so the portal cards + admin list render a real icon
// without uploading anything. Add new options to ICON_OPTIONS.
import {
    LifeBuoy,
    Bug,
    CreditCard,
    Calculator,
    SmartphoneNfc,
    Nfc,
    QrCode,
    ScanLine,
    Receipt,
    ReceiptText,
    Wallet,
    Store,
    ArrowLeftRight,
    RefreshCw,
    ShoppingCart,
    ShoppingBag,
    Wifi,
    Wrench,
    HelpCircle,
    Network,
    Banknote,
} from 'lucide-react';

export const TICKET_TYPE_ICON_OPTIONS = [
    // Payment-industry icons first — the common ticket subjects here.
    { value: 'pos-terminal', label: 'POS terminal', Icon: Calculator },
    { value: 'pos-transaction', label: 'POS transaction', Icon: Receipt },
    { value: 'card-payment', label: 'Card payment', Icon: CreditCard },
    { value: 'softpos', label: 'SoftPOS', Icon: SmartphoneNfc },
    { value: 'softpos-transaction', label: 'SoftPOS transaction', Icon: Nfc },
    { value: 'contactless', label: 'Contactless / tap', Icon: Nfc },
    { value: 'qr-payment', label: 'QR payment', Icon: QrCode },
    { value: 'scan', label: 'Scan / read', Icon: ScanLine },
    {
        value: 'ecommerce-transaction',
        label: 'eCommerce transaction',
        Icon: ShoppingBag,
    },
    { value: 'ecommerce', label: 'eCommerce', Icon: ShoppingCart },
    { value: 'ips-transaction', label: 'IPS transaction', Icon: ArrowLeftRight },
    { value: 'merchant', label: 'Merchant', Icon: Store },
    { value: 'wallet', label: 'Wallet', Icon: Wallet },
    { value: 'settlement', label: 'Settlement', Icon: RefreshCw },
    { value: 'receipt', label: 'Receipt', Icon: ReceiptText },
    { value: 'banknote', label: 'Payment', Icon: Banknote },
    // General support / connectivity icons.
    { value: 'life-buoy', label: 'Support', Icon: LifeBuoy },
    { value: 'bug', label: 'Bug', Icon: Bug },
    { value: 'network', label: 'Network', Icon: Network },
    { value: 'wifi', label: 'Connectivity', Icon: Wifi },
    { value: 'wrench', label: 'Maintenance', Icon: Wrench },
    { value: 'help-circle', label: 'Question', Icon: HelpCircle },
];

const BY_VALUE = Object.fromEntries(
    TICKET_TYPE_ICON_OPTIONS.map((o) => [o.value, o.Icon]),
);

// Resolve a stored icon key to a component. Falls back to LifeBuoy so a
// missing / unknown key still renders something sensible.
export function getTicketTypeIcon(value) {
    return BY_VALUE[value] || LifeBuoy;
}
