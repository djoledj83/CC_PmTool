import { api } from './api';

// Pulls a file (e.g. an Excel export) from an authenticated API endpoint
// and triggers a browser download. We can't just `window.location.assign`
// the URL because the API requires a Bearer token in the Authorization
// header; instead we fetch as a Blob, then synthesize an anchor click.
//
// `filenameFallback` is used when the server doesn't send a
// Content-Disposition header (or the parser can't extract the filename).
export async function downloadFromApi(
    url,
    { params, filenameFallback = 'download' } = {},
) {
    const response = await api.get(url, {
        params,
        responseType: 'blob',
    });

    const filename =
        extractFilename(response.headers?.['content-disposition']) ||
        filenameFallback;

    const blob = new Blob([response.data], {
        type:
            response.headers?.['content-type'] ||
            'application/octet-stream',
    });
    const blobUrl = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give Safari/Firefox a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// Pulls a filename out of a Content-Disposition header. Handles both
// `filename="foo.xlsx"` and the RFC 5987 `filename*=UTF-8''foo.xlsx` form.
function extractFilename(header) {
    if (!header || typeof header !== 'string') return null;
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
    if (star?.[1]) {
        try {
            return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
        } catch {
            /* fall through */
        }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain?.[1] || null;
}
