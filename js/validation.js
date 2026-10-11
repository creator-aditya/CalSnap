/**
 * CalSnap - Event validation.
 *
 * Kept separate from both the extractor and the UI so the same rules are used by
 * the web form, the calendar generators and the tests.
 *
 * Two severities:
 *   errors   - block calendar generation (required detail missing or impossible)
 *   warnings - do not block, but the user is told what CalSnap is assuming
 */
(function (root) {
    'use strict';

    var DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
    var TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
    var WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MONTH = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    var Validation = {

        isDate: function (value) {
            var match = String(value || '').match(DATE_PATTERN);
            if (!match) return false;
            var year = parseInt(match[1], 10);
            var month = parseInt(match[2], 10);
            var day = parseInt(match[3], 10);
            if (month < 1 || month > 12 || day < 1 || day > 31) return false;
            var probe = new Date(year, month - 1, day, 12, 0, 0, 0);
            return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
        },

        isTime: function (value) {
            return TIME_PATTERN.test(String(value || ''));
        },

        /** "2026-05-01" + "14:30" -> local Date. */
        toLocalDate: function (dateStr, timeStr) {
            if (!this.isDate(dateStr) || !this.isTime(timeStr)) return null;
            var d = String(dateStr).split('-');
            var t = String(timeStr).split(':');
            return new Date(
                parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10),
                parseInt(t[0], 10), parseInt(t[1], 10), 0, 0
            );
        },

        /** Start time plus one hour, wrapping to 23:59 rather than into tomorrow. */
        defaultEndTime: function (startTime) {
            if (!this.isTime(startTime)) return '';
            var parts = String(startTime).split(':');
            var minutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + 60;
            if (minutes > 23 * 60 + 59) minutes = 23 * 60 + 59;
            return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' +
                String(minutes % 60).padStart(2, '0');
        },

        /** The end time that will actually be written into a calendar file. */
        effectiveEndTime: function (event) {
            if (event && this.isTime(event.endTime)) return event.endTime;
            return this.defaultEndTime(event ? event.startTime : '');
        },

        /** "Friday, 1 May 2026 at 14:30" for confirmations and test output. */
        describe: function (event) {
            if (!event || !this.isDate(event.date)) return '';
            var d = String(event.date).split('-');
            var date = new Date(parseInt(d[0], 10), parseInt(d[1], 10) - 1, parseInt(d[2], 10), 12, 0, 0, 0);
            var text = WEEKDAY[date.getDay()] + ', ' + date.getDate() + ' ' + MONTH[date.getMonth()] +
                ' ' + date.getFullYear();
            if (this.isTime(event.startTime)) text += ' at ' + event.startTime;
            return text;
        },

        /**
         * Validate the reviewed form values.
         * @param {object} event {title, date, startTime, endTime, location, description, reminder}
         * @param {object} [options] {now: Date}
         * @returns {{ok: boolean, errors: Array, warnings: Array, event: object}}
         */
        validate: function (event, options) {
            var input = event || {};
            var now = (options && options.now instanceof Date) ? options.now : new Date();
            var errors = [];
            var warnings = [];

            var title = String(input.title || '').trim().replace(/\s{2,}/g, ' ');
            var date = String(input.date || '').trim();
            var startTime = String(input.startTime || '').trim();
            var endTime = String(input.endTime || '').trim();
            var location = String(input.location || '').trim();
            var description = String(input.description || '').trim();
            var reminder = String(input.reminder || 'none').trim();

            // Carried through from extraction: the end time falls on the next day.
            // Only trusted when there is actually an end time earlier than the start
            // time — the only case where "next day" makes physical sense. A stale
            // true from extraction is silently corrected when the user has since
            // edited the times into a same-day range.
            var endNextDay = (input.endNextDay === true || input.endNextDay === 'true') &&
                this.isTime(endTime) && this.isTime(startTime) &&
                endTime <= startTime;

            // --- Required details -------------------------------------------------
            if (!title) {
                errors.push({ field: 'title', message: 'Add an event title.' });
            } else if (title.length > 200) {
                errors.push({ field: 'title', message: 'The title is too long (200 characters maximum).' });
            }

            if (!date) {
                errors.push({ field: 'date', message: 'Choose an event date.' });
            } else if (!this.isDate(date)) {
                errors.push({ field: 'date', message: 'That date is not valid. Use the date picker to choose one.' });
            }

            if (!startTime) {
                errors.push({ field: 'startTime', message: 'Choose a start time.' });
            } else if (!this.isTime(startTime)) {
                errors.push({ field: 'startTime', message: 'That start time is not valid. Use the time picker to choose one.' });
            }

            if (endTime && !this.isTime(endTime)) {
                errors.push({ field: 'endTime', message: 'That end time is not valid. Use the time picker to choose one, or clear it.' });
            }

            var start = this.toLocalDate(date, startTime);
            var end = this.toLocalDate(date, endTime);

            // An end time that belongs to the next day ("from noon until midnight").
            // The event genuinely runs past midnight, so validation and the calendar
            // layer must both treat it that way instead of calling it a backwards range.
            if (end && endNextDay) {
                end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
            }

            // --- Chronology -------------------------------------------------------
            if (start && end) {
                if (end.getTime() === start.getTime()) {
                    errors.push({ field: 'endTime', message: 'The end time must be different from the start time.' });
                } else if (end.getTime() < start.getTime()) {
                    errors.push({ field: 'endTime', message: 'The end time is before the start time.' });
                } else if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) {
                    warnings.push({ field: 'endTime', message: 'This event is longer than 24 hours.' });
                }
            }

            if (start && !endTime) {
                warnings.push({
                    field: 'endTime',
                    message: 'No end time was given, so the event will be created as one hour long ' +
                        '(' + startTime + ' to ' + this.defaultEndTime(startTime) + ').'
                });
            }

            // --- Past / far future ------------------------------------------------
            if (start) {
                if (start.getTime() < now.getTime() - 6 * 60 * 60 * 1000) {
                    warnings.push({
                        field: 'date',
                        message: 'This start time is in the past, so a reminder may never fire.'
                    });
                } else if (start.getTime() - now.getTime() > 5 * 365 * 24 * 60 * 60 * 1000) {
                    warnings.push({ field: 'date', message: 'This date is more than five years away. Double-check it.' });
                }
            }

            // --- Reminder ---------------------------------------------------------
            if (!/^(none|15|60|1440)$/.test(reminder)) {
                warnings.push({ field: 'reminder', message: 'Unrecognised reminder value; no reminder will be included.' });
                reminder = 'none';
            }

            return {
                ok: errors.length === 0,
                errors: errors,
                warnings: warnings,
                event: {
                    title: title,
                    date: date,
                    startTime: startTime,
                    endTime: endTime,
                    endNextDay: endNextDay,
                    location: location,
                    description: description,
                    reminder: reminder
                }
            };
        }
    };

    root.Validation = Validation;

    if (typeof module === 'object' && module.exports) module.exports = Validation;
})(typeof globalThis !== 'undefined' ? globalThis : this);
