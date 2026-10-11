/**
 * Loads the browser modules (which attach themselves to globalThis) into Node so
 * the test suite can exercise exactly the code the web application ships.
 *
 * Load order matters: js/calendar.js calls into Validation when it is present.
 */
'use strict';

const path = require('path');

require(path.join(__dirname, '..', 'js', 'extractor.js'));
require(path.join(__dirname, '..', 'js', 'validation.js'));
require(path.join(__dirname, '..', 'js', 'calendar.js'));

module.exports = {
    Extractor: globalThis.Extractor,
    Validation: globalThis.Validation,
    CalendarCore: globalThis.CalendarCore
};
