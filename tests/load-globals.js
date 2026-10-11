/**
 * Loads the browser modules (which attach themselves to globalThis) into Node so
 * the test suite can exercise exactly the code the web application ships.
 *
 * Load order matches index.html: urlfetch, extractor, validation, calendar.
 */
'use strict';

const path = require('path');

require(path.join(__dirname, '..', 'js', 'urlfetch.js'));
require(path.join(__dirname, '..', 'js', 'extractor.js'));
require(path.join(__dirname, '..', 'js', 'validation.js'));
require(path.join(__dirname, '..', 'js', 'calendar.js'));

module.exports = {
    UrlFetch: globalThis.UrlFetch,
    Extractor: globalThis.Extractor,
    Validation: globalThis.Validation,
    CalendarCore: globalThis.CalendarCore
};
