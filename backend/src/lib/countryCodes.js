// Three-letter country codes for project codes (P26-USA-0001).
//
// Resolution order (resolveCountryCode):
//   1. the code an admin set on the country under Templates → Countries
//   2. the ISO 3166-1 alpha-3 code for the name (incl. common aliases:
//      "USA", "UK", "Russia", "Czech Republic", …) or a name that IS an
//      alpha-3 code ("SRB")
//   3. legacy fallback: the first three letters of the name
//   …and "INT" when there's no country at all.
// Existing project codes are never recomputed — this only affects new
// projects.

const FALLBACK = 'INT';

// ISO 3166-1 alpha-3 → English short name, plus Kosovo (XKX, the
// user-assigned code used by the EU / IMF).
const ISO3 = {
    AFG: 'Afghanistan', ALA: 'Aland Islands', ALB: 'Albania', DZA: 'Algeria',
    ASM: 'American Samoa', AND: 'Andorra', AGO: 'Angola', AIA: 'Anguilla',
    ATA: 'Antarctica', ATG: 'Antigua and Barbuda', ARG: 'Argentina',
    ARM: 'Armenia', ABW: 'Aruba', AUS: 'Australia', AUT: 'Austria',
    AZE: 'Azerbaijan', BHS: 'Bahamas', BHR: 'Bahrain', BGD: 'Bangladesh',
    BRB: 'Barbados', BLR: 'Belarus', BEL: 'Belgium', BLZ: 'Belize',
    BEN: 'Benin', BMU: 'Bermuda', BTN: 'Bhutan', BOL: 'Bolivia',
    BES: 'Bonaire, Sint Eustatius and Saba', BIH: 'Bosnia and Herzegovina',
    BWA: 'Botswana', BVT: 'Bouvet Island', BRA: 'Brazil',
    IOT: 'British Indian Ocean Territory', BRN: 'Brunei Darussalam',
    BGR: 'Bulgaria', BFA: 'Burkina Faso', BDI: 'Burundi', CPV: 'Cabo Verde',
    KHM: 'Cambodia', CMR: 'Cameroon', CAN: 'Canada', CYM: 'Cayman Islands',
    CAF: 'Central African Republic', TCD: 'Chad', CHL: 'Chile', CHN: 'China',
    CXR: 'Christmas Island', CCK: 'Cocos (Keeling) Islands', COL: 'Colombia',
    COM: 'Comoros', COD: 'Democratic Republic of the Congo', COG: 'Congo',
    COK: 'Cook Islands', CRI: 'Costa Rica', CIV: "Cote d'Ivoire",
    HRV: 'Croatia', CUB: 'Cuba', CUW: 'Curacao', CYP: 'Cyprus',
    CZE: 'Czechia', DNK: 'Denmark', DJI: 'Djibouti', DMA: 'Dominica',
    DOM: 'Dominican Republic', ECU: 'Ecuador', EGY: 'Egypt',
    SLV: 'El Salvador', GNQ: 'Equatorial Guinea', ERI: 'Eritrea',
    EST: 'Estonia', SWZ: 'Eswatini', ETH: 'Ethiopia',
    FLK: 'Falkland Islands', FRO: 'Faroe Islands', FJI: 'Fiji',
    FIN: 'Finland', FRA: 'France', GUF: 'French Guiana',
    PYF: 'French Polynesia', ATF: 'French Southern Territories', GAB: 'Gabon',
    GMB: 'Gambia', GEO: 'Georgia', DEU: 'Germany', GHA: 'Ghana',
    GIB: 'Gibraltar', GRC: 'Greece', GRL: 'Greenland', GRD: 'Grenada',
    GLP: 'Guadeloupe', GUM: 'Guam', GTM: 'Guatemala', GGY: 'Guernsey',
    GIN: 'Guinea', GNB: 'Guinea-Bissau', GUY: 'Guyana', HTI: 'Haiti',
    HMD: 'Heard Island and McDonald Islands', VAT: 'Holy See',
    HND: 'Honduras', HKG: 'Hong Kong', HUN: 'Hungary', ISL: 'Iceland',
    IND: 'India', IDN: 'Indonesia', IRN: 'Iran', IRQ: 'Iraq', IRL: 'Ireland',
    IMN: 'Isle of Man', ISR: 'Israel', ITA: 'Italy', JAM: 'Jamaica',
    JPN: 'Japan', JEY: 'Jersey', JOR: 'Jordan', KAZ: 'Kazakhstan',
    KEN: 'Kenya', KIR: 'Kiribati', PRK: 'North Korea', KOR: 'South Korea',
    KWT: 'Kuwait', KGZ: 'Kyrgyzstan', LAO: 'Laos', LVA: 'Latvia',
    LBN: 'Lebanon', LSO: 'Lesotho', LBR: 'Liberia', LBY: 'Libya',
    LIE: 'Liechtenstein', LTU: 'Lithuania', LUX: 'Luxembourg', MAC: 'Macao',
    MDG: 'Madagascar', MWI: 'Malawi', MYS: 'Malaysia', MDV: 'Maldives',
    MLI: 'Mali', MLT: 'Malta', MHL: 'Marshall Islands', MTQ: 'Martinique',
    MRT: 'Mauritania', MUS: 'Mauritius', MYT: 'Mayotte', MEX: 'Mexico',
    FSM: 'Micronesia', MDA: 'Moldova', MCO: 'Monaco', MNG: 'Mongolia',
    MNE: 'Montenegro', MSR: 'Montserrat', MAR: 'Morocco', MOZ: 'Mozambique',
    MMR: 'Myanmar', NAM: 'Namibia', NRU: 'Nauru', NPL: 'Nepal',
    NLD: 'Netherlands', NCL: 'New Caledonia', NZL: 'New Zealand',
    NIC: 'Nicaragua', NER: 'Niger', NGA: 'Nigeria', NIU: 'Niue',
    NFK: 'Norfolk Island', MKD: 'North Macedonia',
    MNP: 'Northern Mariana Islands', NOR: 'Norway', OMN: 'Oman',
    PAK: 'Pakistan', PLW: 'Palau', PSE: 'Palestine', PAN: 'Panama',
    PNG: 'Papua New Guinea', PRY: 'Paraguay', PER: 'Peru',
    PHL: 'Philippines', PCN: 'Pitcairn', POL: 'Poland', PRT: 'Portugal',
    PRI: 'Puerto Rico', QAT: 'Qatar', REU: 'Reunion', ROU: 'Romania',
    RUS: 'Russian Federation', RWA: 'Rwanda', BLM: 'Saint Barthelemy',
    SHN: 'Saint Helena', KNA: 'Saint Kitts and Nevis', LCA: 'Saint Lucia',
    MAF: 'Saint Martin', SPM: 'Saint Pierre and Miquelon',
    VCT: 'Saint Vincent and the Grenadines', WSM: 'Samoa',
    SMR: 'San Marino', STP: 'Sao Tome and Principe', SAU: 'Saudi Arabia',
    SEN: 'Senegal', SRB: 'Serbia', SYC: 'Seychelles', SLE: 'Sierra Leone',
    SGP: 'Singapore', SXM: 'Sint Maarten', SVK: 'Slovakia', SVN: 'Slovenia',
    SLB: 'Solomon Islands', SOM: 'Somalia', ZAF: 'South Africa',
    SGS: 'South Georgia and the South Sandwich Islands', SSD: 'South Sudan',
    ESP: 'Spain', LKA: 'Sri Lanka', SDN: 'Sudan', SUR: 'Suriname',
    SJM: 'Svalbard and Jan Mayen', SWE: 'Sweden', CHE: 'Switzerland',
    SYR: 'Syria', TWN: 'Taiwan', TJK: 'Tajikistan', TZA: 'Tanzania',
    THA: 'Thailand', TLS: 'Timor-Leste', TGO: 'Togo', TKL: 'Tokelau',
    TON: 'Tonga', TTO: 'Trinidad and Tobago', TUN: 'Tunisia', TUR: 'Turkiye',
    TKM: 'Turkmenistan', TCA: 'Turks and Caicos Islands', TUV: 'Tuvalu',
    UGA: 'Uganda', UKR: 'Ukraine', ARE: 'United Arab Emirates',
    GBR: 'United Kingdom', USA: 'United States',
    UMI: 'United States Minor Outlying Islands', URY: 'Uruguay',
    UZB: 'Uzbekistan', VUT: 'Vanuatu', VEN: 'Venezuela', VNM: 'Vietnam',
    VGB: 'British Virgin Islands', VIR: 'US Virgin Islands',
    WLF: 'Wallis and Futuna', ESH: 'Western Sahara', YEM: 'Yemen',
    ZMB: 'Zambia', ZWE: 'Zimbabwe', XKX: 'Kosovo',
};

// Other names people type → alpha-3.
const ALIASES = {
    USA: ['USA', 'US', 'U.S.', 'U.S.A.', 'United States of America', 'America'],
    GBR: [
        'UK', 'U.K.', 'Great Britain', 'Britain',
        'United Kingdom of Great Britain and Northern Ireland',
        'England', 'Scotland', 'Wales', 'Northern Ireland',
    ],
    RUS: ['Russia'],
    KOR: ['Korea', 'Republic of Korea', 'Korea, Republic of', 'Korea (South)'],
    PRK: ["Democratic People's Republic of Korea", 'DPRK', 'Korea (North)'],
    CZE: ['Czech Republic'],
    BIH: ['Bosnia', 'Bosnia & Herzegovina', 'BiH'],
    MKD: ['Macedonia', 'FYROM', 'Republic of North Macedonia'],
    MDA: ['Republic of Moldova', 'Moldova, Republic of'],
    IRN: ['Islamic Republic of Iran', 'Iran, Islamic Republic of'],
    SYR: ['Syrian Arab Republic'],
    VNM: ['Viet Nam'],
    LAO: ["Lao People's Democratic Republic", 'Lao PDR'],
    BOL: ['Plurinational State of Bolivia', 'Bolivia, Plurinational State of'],
    VEN: ['Bolivarian Republic of Venezuela', 'Venezuela, Bolivarian Republic of'],
    TZA: ['United Republic of Tanzania', 'Tanzania, United Republic of'],
    CIV: ['Ivory Coast', "Côte d'Ivoire"],
    VAT: ['Vatican', 'Vatican City', 'Vatican City State'],
    TUR: ['Turkey', 'Türkiye'],
    NLD: ['Holland', 'The Netherlands'],
    SWZ: ['Swaziland'],
    CPV: ['Cape Verde'],
    MMR: ['Burma'],
    TLS: ['East Timor'],
    ARE: ['UAE', 'Emirates'],
    COD: ['DR Congo', 'DRC', 'Congo (Kinshasa)', 'Congo, Democratic Republic of the'],
    COG: ['Republic of the Congo', 'Congo (Brazzaville)', 'Congo-Brazzaville'],
    BRN: ['Brunei'],
    FSM: ['Federated States of Micronesia', 'Micronesia, Federated States of'],
    PSE: ['State of Palestine', 'Palestinian Territories'],
    MAC: ['Macau'],
    HKG: ['Hong Kong SAR'],
    TWN: ['Taiwan, Province of China', 'Republic of China'],
    ALA: ['Åland', 'Aland'],
    CUW: ['Curaçao'],
    REU: ['Réunion'],
    BLM: ['Saint Barthélemy', 'St Barts'],
    SHN: ['Saint Helena, Ascension and Tristan da Cunha'],
    MAF: ['Saint Martin (French part)'],
    SXM: ['Sint Maarten (Dutch part)'],
    STP: ['São Tomé and Príncipe', 'Sao Tome'],
    VGB: ['Virgin Islands (British)', 'Virgin Islands, British'],
    VIR: ['Virgin Islands (U.S.)', 'Virgin Islands, U.S.', 'United States Virgin Islands'],
    FLK: ['Falkland Islands (Malvinas)', 'Malvinas'],
    GMB: ['The Gambia'],
    BHS: ['The Bahamas'],
    KGZ: ['Kyrgyz Republic'],
    SVK: ['Slovak Republic'],
    LBY: ['Libyan Arab Jamahiriya'],
    CHN: ["People's Republic of China", 'PRC'],
    DEU: ['Deutschland'],
    SRB: ['Srbija', 'Republic of Serbia'],
    HRV: ['Hrvatska'],
    MNE: ['Crna Gora'],
    SVN: ['Slovenija'],
    XKX: ['Kosova', 'Republic of Kosovo'],
};

// "Côte d’Ivoire" / "cote d'ivoire" / "St. Lucia" → one comparable form.
function normalizeName(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/^the /, '')
        .replace(/^st /, 'saint ')
        .replace(/\s+/g, ' ');
}

const BY_NAME = new Map();
for (const [code, name] of Object.entries(ISO3)) BY_NAME.set(normalizeName(name), code);
for (const [code, names] of Object.entries(ALIASES)) {
    for (const n of names) BY_NAME.set(normalizeName(n), code);
}

const isAlpha3 = (v) => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim());

// ISO alpha-3 for a country name (or an alpha-3 typed as the name), else null.
function isoCodeFor(name) {
    if (!name) return null;
    const raw = String(name).trim();
    if (isAlpha3(raw) && ISO3[raw.toUpperCase()]) return raw.toUpperCase();
    return BY_NAME.get(normalizeName(raw)) || null;
}

// The pre-ISO behaviour: first three letters, padded with X.
function legacyToken(name) {
    const cleaned = String(name || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z]/g, '')
        .toUpperCase();
    if (!cleaned) return FALLBACK;
    return cleaned.slice(0, 3).padEnd(3, 'X');
}

// Synchronous token from a name alone (ISO, else legacy, else INT).
function countryTokenFromName(name) {
    if (!name || !String(name).trim()) return FALLBACK;
    return isoCodeFor(name) || legacyToken(name);
}

// Full resolution, honouring the admin's code on the Countries catalogue.
async function resolveCountryCode(prisma, name) {
    if (!name || !String(name).trim()) return FALLBACK;
    try {
        const row = await prisma.countryOption.findFirst({
            where: { name: { equals: String(name).trim(), mode: 'insensitive' } },
            select: { code: true },
        });
        if (row?.code && isAlpha3(row.code)) return row.code.toUpperCase();
    } catch {
        /* catalogue lookup is best-effort */
    }
    return countryTokenFromName(name);
}

module.exports = {
    COUNTRY_FALLBACK: FALLBACK,
    isoCodeFor,
    isAlpha3,
    legacyToken,
    countryTokenFromName,
    resolveCountryCode,
    normalizeName,
};
