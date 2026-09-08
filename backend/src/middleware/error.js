const { ZodError } = require('zod');
const multer = require('multer');

function notFound(req, res) {
    res.status(404).json({ error: 'Not found' });
}

function errorHandler(err, req, res, next) {
    if (err instanceof ZodError) {
        const flat = err.flatten();
        // Build a human-readable summary naming the offending field(s) so
        // the client toast is actionable instead of a bare "Validation
        // failed" (which hid, e.g., a legacy task whose stored status /
        // priority is outside today's allowed set).
        const parts = [];
        for (const [field, msgs] of Object.entries(flat.fieldErrors || {})) {
            if (Array.isArray(msgs) && msgs.length) {
                parts.push(`${field}: ${msgs[0]}`);
            }
        }
        if (Array.isArray(flat.formErrors)) parts.push(...flat.formErrors);
        const summary = parts.join('; ');
        return res.status(400).json({
            error: summary ? `Validation failed — ${summary}` : 'Validation failed',
            details: flat.fieldErrors,
        });
    }

    if (err instanceof multer.MulterError) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message });
    }

    if (err && err.status && err.expose) {
        return res.status(err.status).json({ error: err.message });
    }

    if (err && /^Only .* allowed/i.test(err.message || '')) {
        return res.status(400).json({ error: err.message });
    }

    console.error('[unhandled]', err);
    res.status(500).json({ error: 'Internal server error' });
}

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    err.expose = true;
    return err;
}

module.exports = { notFound, errorHandler, httpError };
