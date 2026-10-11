/**
 * CalSnap - Calendar integration.
 *
 * Turns reviewed event details into either:
 *   - a prefilled Google Calendar creation URL, or
 *   - a downloadable iCalendar (.ics) document.
 *
 * Pure logic, no DOM access (the download itself lives in js/ui.js), shared with
 * the Node test suite.
 *
 * Specification notes:
 *  - RFC 5545: dates are UTC ("...Z"), text values are escaped, lines are folded
 *    at 75 octets, and every VEVENT needs a UID.
 *  - Google Calendar URL parameters use the same UTC form in `dates=start/end`.
 *  - Reminders are written as VALARM components. The destination application
 *    decides whether it honours them, so the UI never promises a notification.
 */
(function (root) {
    'use strict';

    var PRODID = '-//CalSnap//Smart Event Saver//EN';
    var GOOGLE_ENDPOINT = 'https://calendar.google.com/calendar/render';

    /** Reminder minutes -> human label. */
    var REMINDER_LABELS = {
        '15': '15 minutes before',
        '60': '1 hour before',
        '1440': '1 day before'
    };

    function two(value) {
        return String(value).padStart(2, '0');
    }

    function pad(value, length) {
        return String(value).padStart(length, '0');
    }

    var CalendarCore = {

        REMINDER_LABELS: REMINDER_LABELS,

        /** Message shown next to the Google Calendar button. */
        GOOGLE_REMINDER_NOTICE: 'Google Calendar does not accept a reminder from a link: set the ' +
            'notification again on the Google Calendar page. Opening that page does not save the event.',

        /** Message shown next to the .ics button. */
        ICS_REMINDER_NOTICE: 'The reminder is written into the .ics file as a VALARM. Some calendar ' +
            'applications ignore imported reminders, so check it after importing.',

        /* ------------------------------------------------------------------ *
         * Field helpers
         * ------------------------------------------------------------------ */

        /** Local date + time -> Date, without ever going through UTC parsing. */
        toLocalDate: function (dateStr, timeStr) {
            if (typeof Validation !== 'undefined' && Validation.toLocalDate) {
                return Validation.toLocalDate(dateStr, timeStr);
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) || !/^\d{2}:\d{2}$/.test(String(timeStr))) return null;
            var d = String(dateStr).split('-');
            var t = String(timeStr).split(':');
            return new Date(+d[0], +d[1] - 1, +d[2], +t[0], +t[1], 0, 0);
        },

        /** The end time used for output: the given one, else start + 1 hour. */
        endTimeFor: function (event) {
            if (typeof Validation !== 'undefined' && Validation.effectiveEndTime) {
                return Validation.effectiveEndTime(event);
            }
            if (event && /^\d{2}:\d{2}$/.test(String(event.endTime || ''))) return event.endTime;
            if (!event || !/^\d{2}:\d{2}$/.test(String(event.startTime || ''))) return '';
            var parts = String(event.startTime).split(':');
            var minutes = Math.min(+parts[0] * 60 + +parts[1] + 60, 23 * 60 + 59);
            return two(Math.floor(minutes / 60)) + ':' + two(minutes % 60);
        },

        /** Strict UTC stamp for .ics: YYYYMMDDTHHMMSSZ */
        toICSStamp: function (date) {
            if (!(date instanceof Date) || isNaN(date.getTime())) return '';
            return pad(date.getUTCFullYear(), 4) + two(date.getUTCMonth() + 1) + two(date.getUTCDate()) +
                'T' + two(date.getUTCHours()) + two(date.getUTCMinutes()) + two(date.getUTCSeconds()) + 'Z';
        },

        /** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
        escapeText: function (value) {
            return String(value == null ? '' : value)
                .replace(/\\/g, '\\\\')
                .replace(/;/g, '\\;')
                .replace(/,/g, '\\,')
                .replace(/\r\n|\r|\n/g, '\\n');
        },

        /** RFC 5545 line folding at 75 octets, continued with a leading space. */
        foldLine: function (line) {
            var text = String(line);
            if (text.length <= 75) return text;

            var out = [];
            var current = '';
            for (var i = 0; i < text.length; i++) {
                var char = text[i];
                var bytes = encodeURIComponent(char).replace(/%[0-9A-F]{2}/g, 'x').length;
                var limit = out.length === 0 ? 75 : 74; // a continuation line loses one octet to the space
                if (current.length + bytes > limit) {
                    out.push(current);
                    current = '';
                }
                current += char;
            }
            if (current) out.push(current);
            return out.join('\r\n ');
        },

        /**
         * Resolve the UTC start/end instants for an event.
         * @returns {null|{start: Date, end: Date, startStamp: string, endStamp: string,
         *                 endTime: string, assumedEnd: boolean}}
         */
        resolveWindow: function (event) {
            if (!event) return null;
            var start = this.toLocalDate(event.date, event.startTime);
            var endTime = this.endTimeFor(event);
            var end = this.toLocalDate(event.date, endTime);
            if (!start || !end) return null;

            var assumedEnd = !(event.endTime && /^\d{2}:\d{2}$/.test(String(event.endTime)));
            if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 60 * 60 * 1000);

            return {
                start: start,
                end: end,
                startStamp: this.toICSStamp(start),
                endStamp: this.toICSStamp(end),
                endTime: endTime,
                assumedEnd: assumedEnd
            };
        },

        /* ------------------------------------------------------------------ *
         * Google Calendar
         * ------------------------------------------------------------------ */

        /**
         * Prefilled Google Calendar creation page. Opening it does not create or
         * save anything - the user still reviews and saves inside Google Calendar.
         */
        generateGoogleUrl: function (event) {
            var window_ = this.resolveWindow(event);
            if (!window_) return '';

            var params = new URLSearchParams();
            params.set('action', 'TEMPLATE');
            params.set('text', String(event.title || ''));
            params.set('dates', window_.startStamp.replace(/Z$/, '') + '/' + window_.endStamp.replace(/Z$/, ''));
            params.set('ctz', this.localTimeZone());
            if (event.location) params.set('location', String(event.location));
            if (event.description) params.set('details', String(event.description));

            return GOOGLE_ENDPOINT + '?' + params.toString();
        },

        /** The best available IANA zone name for the current device. */
        localTimeZone: function () {
            try {
                if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
                    var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                    if (zone) return zone;
                }
            } catch (error) {
                void error;
            }
            return 'UTC';
        },

        /* ------------------------------------------------------------------ *
         * iCalendar
         * ------------------------------------------------------------------ */

        /** A UID unique per generated file, containing no personal data. */
        generateUid: function (event) {
            var slug = String((event && event.title) || 'event')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 40) || 'event';
            var random = Math.random().toString(36).slice(2, 10);
            return slug + '-' + Date.now().toString(36) + '-' + random + '@calsnap';
        },

        /**
         * Reminder minutes -> VALARM lines (empty array when none).
         * @param {string} reminder 'none' | '15' | '60' | '1440'
         * @param {string} [eventTitle] used for the notification text
         */
        buildAlarm: function (reminder, eventTitle) {
            var minutes = parseInt(reminder, 10);
            if (!minutes || minutes <= 0 || !REMINDER_LABELS[String(minutes)]) return [];
            var label = REMINDER_LABELS[String(minutes)];
            var description = eventTitle
                ? label + ': ' + String(eventTitle)
                : 'Reminder: ' + label;
            return [
                'BEGIN:VALARM',
                'ACTION:DISPLAY',
                'TRIGGER:-PT' + minutes + 'M',
                'DESCRIPTION:' + this.escapeText(description),
                'END:VALARM'
            ];
        },

        /**
         * Build the .ics document.
         * @param {object} event reviewed details (title, date, startTime, endTime,
         *                location, description, reminder)
         * @param {object} [options] {now: Date} - fixed clock for tests
         * @returns {string} CRLF-joined iCalendar text, or '' when unusable
         */
        generateICS: function (event, options) {
            var window_ = this.resolveWindow(event);
            if (!window_) return '';

            var now = (options && options.now instanceof Date) ? options.now : new Date();
            var lines = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:' + PRODID,
                'CALSCALE:GREGORIAN',
                'METHOD:PUBLISH',
                'X-WR-CALNAME:CalSnap',
                'BEGIN:VEVENT',
                'UID:' + this.generateUid(event),
                'DTSTAMP:' + this.toICSStamp(now),
                'DTSTART:' + window_.startStamp,
                'DTEND:' + window_.endStamp,
                'SUMMARY:' + this.escapeText(event.title)
            ];

            if (event.location) lines.push('LOCATION:' + this.escapeText(event.location));
            if (event.description) lines.push('DESCRIPTION:' + this.escapeText(event.description));
            if (window_.assumedEnd) {
                // Be transparent inside the file about the assumed end time.
                lines.push('X-CALSNAP-NOTE:' + this.escapeText(
                    'No end time was supplied; CalSnap used ' + window_.endTime + ' (one hour after the start).'
                ));
            }

            var alarm = this.buildAlarm(event.reminder, event.title);
            if (alarm.length > 0) {
                lines = lines.concat(alarm);
            }

            lines.push('END:VEVENT', 'END:VCALENDAR');

            return lines.map(function (line) {
                return CalendarCore.foldLine(line);
            }).join('\r\n') + '\r\n';
        },

        /** Safe download file name, e.g. "team-sync-2026-05-01.ics". */
        suggestFileName: function (event) {
            var slug = String((event && event.title) || 'event')
                .toLowerCase()
                .replace(/[\\/:*?"<>|]+/g, ' ')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 60) || 'event';
            var date = String((event && event.date) || '').replace(/[^0-9-]/g, '');
            return slug + (date ? '-' + date : '') + '.ics';
        },

        /**
         * Plain-text summary for the Web Share API. Claims nothing about saving:
         * only the receiving application can create the event.
         */
        buildShareText: function (event) {
            if (!event) return '';
            var when = (typeof Validation !== 'undefined' && Validation.describe)
                ? Validation.describe(event)
                : String(event.date || '');
            var endTime = this.endTimeFor(event);
            var lines = ['Event: ' + String(event.title || '')];
            if (when) lines.push('When: ' + when + (endTime ? ' - ' + endTime : ''));
            if (event.location) lines.push('Where: ' + event.location);
            if (event.description) lines.push('', event.description);
            return lines.join('\n').trim();
        }
    };

    root.CalendarCore = CalendarCore;

    if (typeof module === 'object' && module.exports) module.exports = CalendarCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
