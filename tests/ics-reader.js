/**
 * Minimal iCalendar reader used by the tests.
 *
 * It performs the reverse of what js/calendar.js writes (unfolding continuation
 * lines, unescaping TEXT values, converting UTC stamps back to local Dates) so
 * the tests can assert that a real calendar application would read the file the
 * way CalSnap intended.
 */
'use strict';

/**
 * CRLF + folded continuation lines -> plain logical lines.
 * A fold is CRLF followed by a single space/tab; that space is removed when the
 * lines are rejoined (RFC 5545 section 3.1).
 */
function unfold(icsText) {
    return String(icsText).replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
}

/** The physical lines exactly as they appear in the file. */
function physicalLines(icsText) {
    return String(icsText).split('\r\n').filter(Boolean);
}

/** All "NAME:value" / "NAME;PARAM=x:value" properties. */
function properties(icsText) {
    const map = {};
    for (const line of unfold(icsText)) {
        const index = line.indexOf(':');
        if (index === -1) continue;
        const name = line.slice(0, index).split(';')[0].trim().toUpperCase();
        const value = line.slice(index + 1);
        if (!(name in map)) map[name] = value;
    }
    return map;
}

/** Every line beginning with the given property name. */
function allValues(icsText, propertyName) {
    const wanted = String(propertyName).toUpperCase();
    return unfold(icsText)
        .filter((line) => line.toUpperCase().startsWith(wanted + ':') || line.toUpperCase().startsWith(wanted + ';'))
        .map((line) => line.slice(line.indexOf(':') + 1));
}

/** Undo RFC 5545 TEXT escaping. */
function unescapeText(value) {
    return String(value)
        .replace(/\\n/gi, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
}

/** "20260501T133000Z" -> local Date, so the round trip can be compared. */
function stampToLocalDate(stamp) {
    const m = String(stamp).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/** Local Date + time -> the same UTC stamp form, for expected values. */
function localToStamp(dateStr, timeStr) {
    const [y, mo, d] = String(dateStr).split('-').map(Number);
    const [h, mi] = String(timeStr).split(':').map(Number);
    const date = new Date(y, mo - 1, d, h, mi, 0, 0);
    const two = (n) => String(n).padStart(2, '0');
    return String(date.getUTCFullYear()).padStart(4, '0') + two(date.getUTCMonth() + 1) +
        two(date.getUTCDate()) + 'T' + two(date.getUTCHours()) + two(date.getUTCMinutes()) +
        two(date.getUTCSeconds()) + 'Z';
}

/** Every physical line longer than 75 octets (an RFC 5545 folding violation). */
function overlongLines(icsText) {
    return physicalLines(icsText).filter((line) => Buffer.byteLength(line, 'utf8') > 75);
}

module.exports = {
    unfold,
    physicalLines,
    properties,
    allValues,
    unescapeText,
    stampToLocalDate,
    localToStamp,
    overlongLines
};
