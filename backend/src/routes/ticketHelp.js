// LEGACY — no longer mounted (see src/index.js).
//
// The global "Raise-ticket help" (/api/ticket-help) was replaced by a help
// panel on each ticket type: routes/ticketRequestTypes.js + lib/ticketHelp.js.
// Migration 20261002020000_ticket_type_help copied the old settings onto
// every type. Nothing imports this file any more — it can be removed:
//   git rm backend/src/routes/ticketHelp.js
const express = require('express');

module.exports = express.Router();
