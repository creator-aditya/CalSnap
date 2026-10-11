/**
 * Reads a generated Google Calendar URL back into plain event fields.
 *
 * This is the reverse of CalendarCore.generateGoogleUrl(). A test that only checks
 * "the URL contains 20260314T040000" proves very little; decoding the URL and
 * comparing whole events proves the information actually survives the journey:
 *
 *   paragraph text -> extracted details -> Google Calendar URL -> decoded details
 *
 * The URL carries UTC instants (`dates=YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS`), so the
 * decoded values are converted back to LOCAL date and time - exactly what the
 * person will see when Google Calendar opens the prefilled page.
 */
'use strict';

/** "20260501T133000Z" (or without the Z) -> local {date: '2026-05-01', time: '15:30'} */
function decodeStamp(stamp) {
    // Google Calendar's `dates` parameter is documented as UTC and is read here as such:
    // the digits are UTC and are converted to the local zone, which is exactly what
    // Google does when it renders the prefilled page. A missing Z is still accepted so
    // the reader can also inspect older links, but generateGoogleUrl always writes it.
    const match = String(stamp).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
    if (!match) return null;

    const utc = new Date(Date.UTC(
        +match[1], +match[2] - 1, +match[3],
        +match[4], +match[5], +match[6]
    ));

    const two = (value) => String(value).padStart(2, '0');
    return {
        date: utc.getFullYear() + '-' + two(utc.getMonth() + 1) + '-' + two(utc.getDate()),
        time: two(utc.getHours()) + ':' + two(utc.getMinutes())
    };
}

/**
 * @param {string} url a URL from CalendarCore.generateGoogleUrl()
 * @returns {null|object} the event as the user would see it in Google Calendar
 */
function readGoogleUrl(url) {
    if (!url) return null;

    let parsed;
    try {
        parsed = new URL(String(url));
    } catch (error) {
        return null;
    }

    const params = parsed.searchParams;
    const dates = String(params.get('dates') || '').split('/');
    const start = decodeStamp(dates[0]);
    const end = decodeStamp(dates[1]);
    if (!start || !end) return null;

    return {
        endpoint: parsed.origin + parsed.pathname,
        action: params.get('action'),
        title: params.get('text') || '',
        date: start.date,
        startTime: start.time,
        endDate: end.date,
        endTime: end.time,
        timeZone: params.get('ctz') || '',
        location: params.get('location') || '',
        description: params.get('details') || '',
        /** Every field a calendar entry needs, in one comparable object. */
        summary() {
            return {
                title: this.title,
                date: this.date,
                startTime: this.startTime,
                endTime: this.endTime,
                location: this.location
            };
        }
    };
}

/** Minutes between the decoded start and end (negative if the range is reversed). */
function durationMinutes(event) {
    if (!event) return NaN;
    const toMinutes = (time) => {
        const [h, m] = String(time).split(':').map(Number);
        return h * 60 + m;
    };
    const days = (new Date(event.endDate) - new Date(event.date)) / 86400000;
    return days * 1440 + toMinutes(event.endTime) - toMinutes(event.startTime);
}

module.exports = { readGoogleUrl, decodeStamp, durationMinutes };
