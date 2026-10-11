/**
 * CalSnap - Event extraction engine.
 *
 * Pure logic, no DOM access: this file is reused unchanged by the web UI, by the
 * planned Android share-intent / iOS Share Extension entry points, and by the
 * Node test suite (see tests/extractor.test.js).
 *
 * Design rules taken from the project brief:
 *  - Never invent information. When a detail cannot be identified with
 *    confidence the field stays empty and is reported in `missing` so the UI can
 *    ask the user instead of guessing.
 *  - Keep date/time values as timezone-free local strings (YYYY-MM-DD, HH:MM).
 *    Converting to UTC only happens in the calendar layer, which avoids the
 *    off-by-one-day bug caused by Date#toISOString() on local dates.
 */
(function (root) {
    'use strict';

    var MONTHS = {
        jan: 1, january: 1,
        feb: 2, february: 2,
        mar: 3, march: 3,
        apr: 4, april: 4,
        may: 5,
        jun: 6, june: 6,
        jul: 7, july: 7,
        aug: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, december: 12
    };

    var WEEKDAYS = {
        sunday: 0, sun: 0,
        monday: 1, mon: 1,
        tuesday: 2, tue: 2, tues: 2,
        wednesday: 3, wed: 3,
        thursday: 4, thu: 4, thur: 4, thurs: 4,
        friday: 5, fri: 5,
        saturday: 6, sat: 6
    };

    var MONTH_PATTERN = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
    /*
     * Date forms, tried in order:
     *   1. ISO            2026-03-15
     *   2. numeric        05/01/2026 (or 15/03/2026, detected by the >12 part)
     *   3. month first    April 22, 2026 / Apr 22
     *   4. day first      12 May 2026 / 22nd April
     */
    var DATE_PATTERNS = [
        { source: '\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b', order: 'ymd' },
        { source: '\\b(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{2,4})\\b', order: 'numeric' },
        { source: '\\b(' + MONTH_PATTERN + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\\s+(\\d{4}))?\\b', order: 'mdy' },
        { source: '\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_PATTERN + ')\\.?(?:,)?(?:\\s+(\\d{4}))?\\b', order: 'dmy' }
    ].map(function (entry) {
        return { order: entry.order, regex: new RegExp(entry.source, 'i') };
    });
    var URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/i;
    var SEPARATOR_PATTERN = /^\s*(?:-|–|—|to|until|till|thru|through|@)\s*$/i;
    var TIME_TAIL_PATTERN = /\s*(?:-|–|—|to|until|till|thru|through)\s*$/i;
    // One clock time: "14:30", "2:30pm", "2 pm", "at 9". Bare hours are included
    // so range forms such as "2 to 4 PM" can be normalised before parsing.
    var TIME_PATTERN = /(\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midday|midnight|\b(?:1[0-2]|[1-9])\b(?=\s*(?:a\.?m\.?|p\.?m\.?)))/gi;
    // "2 to 4 PM" / "9-11am": the meridiem at the end belongs to both times.
    var BARE_RANGE_PATTERN = /(^|[^\d:])(\d{1,2})(\s*(?:-|–|—|to|until|till|thru|through)\s*)(\d{1,2})(\s*(?:a\.?m\.?|p\.?m\.?))/gi;
    // Where a location usually stops: the next time, date or labelled field.
    var TIME_FRAGMENT = /(?:\b(?:at|@|from)\s*)?(?:\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|\bnoo?n\b|\bmidnight\b|\b\d{1,2}(?::\d{2})?\s*(?:-|–|—|to|until|till)\s*\d{1,2})/i;
    var DATE_FRAGMENT = new RegExp('\\b(?:today|tonight|tomorrow|tmrw|tmw|yesterday|next\\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\\s+(?:week|weekend|month|year)|on\\s+(?:' + MONTH_PATTERN + '|\\d)|(?:' + MONTH_PATTERN + ')\\s+\\d|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})', 'i');
    var LOCATION_LABEL = /^[ \t>*_>-]*(?:location|where|venue|address|place)\s*[:\-–]\s*(.+)$/i;
    var TITLE_LABEL = /^[ \t>*_>-]*(?:event(?:\s*name)?|title|subject|summary|meeting|webinar|session)\s*[:\-–]\s*(.+)$/i;

    var Extractor = {

        /* ------------------------------------------------------------------ *
         * Public API
         * ------------------------------------------------------------------ */

        /**
         * Extract event details from pasted / shared text.
         *
         * @param {string} text
         * @param {object} [options]
         * @param {Date}   [options.now] Reference "now", used to resolve relative
         *                               dates such as "tomorrow". Defaults to the
         *                               real current time; tests pass a fixed one.
         * @returns {null|object} null when there is no usable text at all.
         */
        extract: function (text, options) {
            if (typeof text !== 'string' || text.trim() === '') return null;

            var now = (options && options.now instanceof Date) ? options.now : new Date();
            var normalized = this.normalizeText(text);
            var lines = normalized.split('\n').map(function (line) {
                return line.trim();
            }).filter(function (line) {
                return line.length > 0;
            });
            if (lines.length === 0) return null;

            var urls = normalized.match(new RegExp(URL_PATTERN.source, 'gi')) || [];
            var parsedDate = this.findDate(normalized, now);
            var timeInfo = this.findTimes(normalized);
            var location = this.findLocation(lines);
            var labeledTitle = this.findLabeledTitle(lines);
            var lineTitle = labeledTitle || this.titleFromLines(lines);
            // The URL slug is only a fallback for a link-only share; real text wins.
            var title = lineTitle || this.titleFromUrl(urls[0]);

            var details = {
                title: title || '',
                date: parsedDate ? this.formatDate(parsedDate.date) : '',
                startTime: timeInfo.start || '',
                endTime: timeInfo.end || '',
                location: location || '',
                // The user's own words are the most faithful description; nothing
                // is summarised or invented here.
                description: normalized,
                urls: urls,
                missing: []
            };

            // Record which phrase produced each value so the UI can explain
            // itself and the tests can assert provenance.
            details.sources = {
                title: labeledTitle ? 'label' : (title ? 'line' : ''),
                date: parsedDate ? parsedDate.matched : '',
                startTime: timeInfo.startMatched || '',
                endTime: timeInfo.endMatched || '',
                location: location ? 'text' : '',
                relative: parsedDate ? !!parsedDate.relative : false
            };

            details.missing = this.findMissing(details);
            return details;
        },

        /** Which required details are still unknown after extraction. */
        findMissing: function (details) {
            var missing = [];
            if (!details.title) missing.push('title');
            if (!details.date) missing.push('date');
            if (!details.startTime) missing.push('startTime');
            return missing;
        },

        /** True when the text carries at least one link. */
        hasUrl: function (text) {
            return URL_PATTERN.test(this.normalizeText(text || ''));
        },

        firstUrl: function (text) {
            var match = this.normalizeText(text || '').match(URL_PATTERN);
            return match ? match[0] : '';
        },

        /**
         * A shared link alone cannot be read from the browser (cross-origin
         * fetch is blocked), so report that honestly instead of pretending the
         * extraction worked. Returns null when the text is not URL-only.
         */
        urlOnlyFeedback: function (text) {
            var normalized = this.normalizeText(text || '');
            if (!normalized) return null;
            var withoutUrls = normalized.replace(new RegExp(URL_PATTERN.source, 'gi'), ' ')
                .replace(/[|·•\-–—:,\s]+/g, ' ')
                .trim();
            if (withoutUrls.length >= 3) return null;
            return {
                url: this.firstUrl(normalized),
                message: 'This looks like a link only. CalSnap cannot read a webpage from the ' +
                    'browser because of cross-origin security restrictions, so no event details ' +
                    'were extracted. Open the page, copy the event text (or use its Share button ' +
                    'and pick CalSnap), then paste it here.'
            };
        },

        /* ------------------------------------------------------------------ *
         * Text helpers
         * ------------------------------------------------------------------ */

        /** Tidy whitespace/zero-width characters without changing the wording. */
        normalizeText: function (text) {
            if (typeof text !== 'string') return '';
            return text
                .replace(/\u00a0/g, ' ')
                .replace(/[\u200b-\u200d\ufeff]/g, '')
                .replace(/\r\n?/g, '\n')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        },

        to24Hour: function (hours, minutes) {
            var h = parseInt(hours, 10);
            var m = parseInt(minutes || 0, 10);
            if (isNaN(h) || isNaN(m)) return '';
            if (h > 23 || m > 59) return '';
            return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        },

        /** YYYY-MM-DD built from local calendar parts (never from toISOString). */
        formatDate: function (date) {
            return [
                String(date.getFullYear()).padStart(4, '0'),
                String(date.getMonth() + 1).padStart(2, '0'),
                String(date.getDate()).padStart(2, '0')
            ].join('-');
        },

        validDate: function (year, month, day) {
            var y = parseInt(year, 10);
            var m = parseInt(month, 10);
            var d = parseInt(day, 10);
            if (!y || y < 1900 || y > 2200) return null;
            if (!m || m < 1 || m > 12) return null;
            if (!d || d < 1 || d > 31) return null;
            var probe = new Date(y, m - 1, d, 12, 0, 0, 0);
            if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
                return null; // rolled over, e.g. 31 February
            }
            return probe;
        },

        /* ------------------------------------------------------------------ *
         * Dates
         * ------------------------------------------------------------------ */

        /**
         * Find the first date-like phrase and convert it to a local Date.
         * @returns {null|{date: Date, matched: string, relative: boolean}}
         */
        findDate: function (text, now) {
            var reference = now instanceof Date ? now : new Date();
            var lower = text.toLowerCase();

            var relative = this.findRelativeDate(lower, reference);
            if (relative) return relative;

            for (var i = 0; i < DATE_PATTERNS.length; i++) {
                var match = text.match(DATE_PATTERNS[i].regex);
                if (!match) continue;
                var parts = this.partsFromMatch(match, DATE_PATTERNS[i].order, reference);
                if (!parts) continue;
                var date = this.validDate(parts.year, parts.month, parts.day);
                if (!date) continue;
                return { date: date, matched: match[0], relative: false };
            }

            return this.findWeekday(lower, reference);
        },

        /** Turn a regex match into {year, month, day} using its shape. */
        partsFromMatch: function (match, order, reference) {
            var a = match[1];
            var b = match[2];
            var c = match[3];

            if (order === 'ymd') { // YYYY-MM-DD
                return { year: a, month: b, day: c };
            }

            if (order === 'mdy' || order === 'dmy') { // Month name, day and optional year
                var monthName = order === 'mdy' ? a : b;
                var dayText = order === 'mdy' ? b : a;
                var month = MONTHS[String(monthName).toLowerCase().replace(/\.$/, '')];
                if (!month) return null;
                // No year supplied: pick the next occurrence of that month/day so
                // "Jan 5" written in December means next January, not last January.
                return {
                    year: c ? c : this.inferYear(month, parseInt(dayText, 10), reference),
                    month: month,
                    day: dayText
                };
            }

            if (c === undefined) return null; // a two-part numeric date is not a date
            var first = parseInt(a, 10);
            var second = parseInt(b, 10);

            if (first > 12 && second <= 12) { // unambiguous day/month/year
                return { year: c, month: second, day: first };
            }
            if (second > 12 && first <= 12) { // unambiguous month/day/year
                return { year: c, month: first, day: second };
            }
            // Ambiguous (03/04/2026): treat as month/day, the common event format.
            return { year: c, month: first, day: second };
        },

        /**
         * Year for a date written without one, resolved against the reference date
         * (so the same input always gives the same answer for a given clock).
         */
        inferYear: function (month, day, reference) {
            var base = reference instanceof Date ? reference : new Date();
            var year = base.getFullYear();
            var startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate());
            var candidate = new Date(year, month - 1, day, 12, 0, 0, 0);
            if (isNaN(candidate.getTime()) || candidate.getMonth() !== month - 1) return String(year);
            return candidate < startOfToday ? String(year + 1) : String(year);
        },

        findRelativeDate: function (lowerText, reference) {
            var base = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
            var rel = /\b(today|tonight|tomorrow|tmrw|tmw|day after tomorrow|yesterday|next week|this weekend|next month|in (\d{1,3}) (day|days|week|weeks|month|months))\b/;
            var match = lowerText.match(rel);
            if (!match) return null;
            var phrase = match[0];
            var date = new Date(base.getTime());

            switch (phrase) {
                case 'today':
                case 'tonight':
                    break;
                case 'tomorrow':
                case 'tmrw':
                case 'tmw':
                    date.setDate(date.getDate() + 1);
                    break;
                case 'day after tomorrow':
                    date.setDate(date.getDate() + 2);
                    break;
                case 'yesterday':
                    date.setDate(date.getDate() - 1);
                    break;
                case 'next week':
                    date.setDate(date.getDate() + 7);
                    break;
                case 'next month':
                    date.setMonth(date.getMonth() + 1);
                    break;
                case 'this weekend': // the coming Saturday
                    date.setDate(date.getDate() + ((6 - date.getDay() + 7) % 7 || 7));
                    break;
                default: { // "in 3 days" / "in 2 weeks" / "in 1 month"
                    var amount = parseInt(match[2], 10);
                    var unit = match[3];
                    if (/week/.test(unit)) date.setDate(date.getDate() + amount * 7);
                    else if (/month/.test(unit)) date.setMonth(date.getMonth() + amount);
                    else date.setDate(date.getDate() + amount);
                }
            }
            return { date: date, matched: phrase, relative: true };
        },

        findWeekday: function (lowerText, reference) {
            var match = lowerText.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/);
            if (!match) return null;

            var target = WEEKDAYS[match[1]];
            if (target === undefined) return null;

            var base = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
            var delta = (target - base.getDay() + 7) % 7;
            if (delta === 0) delta = 7; // a bare weekday means the next one
            base.setDate(base.getDate() + delta);

            return { date: base, matched: match[0], relative: true };
        },

        /* ------------------------------------------------------------------ *
         * Times
         * ------------------------------------------------------------------ */

        /**
         * Find the start time, and the end time when the text expresses a range.
         * No end time is inferred here: an invented end time is worse than an
         * empty field, so the caller decides (see Validation.defaultEndTime).
         */
        findTimes: function (text) {
            var self = this;
            var normalized = this.normalizeTimeRanges(text);
            var found = [];
            var match;
            TIME_PATTERN.lastIndex = 0;

            while ((match = TIME_PATTERN.exec(normalized)) !== null) {
                var raw = match[0].trim();
                var minutes = this.parseTime(raw);
                if (!minutes && !/^(?:midnight|12\s*a\.?m\.?)$/i.test(raw)) continue;
                if (found.some(function (entry) { return entry.minutes === minutes; })) continue;
                found.push({
                    minutes: minutes,
                    value: this.to24Hour(Math.floor(minutes / 60), minutes % 60),
                    raw: raw,
                    start: match.index,
                    end: match.index + match[0].length
                });
                if (found.length >= 6) break;
            }

            if (found.length === 0) return { start: '', end: '', times: [] };

            var result = {
                start: found[0].value,
                startMatched: found[0].raw,
                end: '',
                endMatched: '',
                times: found.map(function (entry) { return entry.value; })
            };

            if (found.length > 1) {
                var between = normalized.slice(found[0].end, found[1].start);
                var isRange = SEPARATOR_PATTERN.test(between) ||
                    TIME_TAIL_PATTERN.test(found[0].raw) ||
                    TIME_TAIL_PATTERN.test(between);
                if (isRange) {
                    var endMinutes = self.inferEndMeridiem(found[0].raw, found[1], found[0].minutes);
                    if (endMinutes > found[0].minutes) {
                        result.end = self.to24Hour(Math.floor(endMinutes / 60), endMinutes % 60);
                        result.endMatched = found[1].raw;
                    }
                }
            }

            return result;
        },

        /**
         * "2 to 4 PM" -> "2 PM to 4 PM". The meridiem written once at the end of a
         * range applies to both times, so it is copied onto the bare start hour
         * before the times are parsed.
         */
        normalizeTimeRanges: function (text) {
            return String(text).replace(BARE_RANGE_PATTERN, function (whole, lead, first, sep, second, trail) {
                if (!lead && /\d/.test(lead)) return whole;
                return lead + first + ' ' + trail.trim() + sep + second + trail;
            });
        },

        /** "2 PM", "14:30", "noon", "midnight" -> minutes since midnight, else 0. */
        parseTime: function (str) {
            if (typeof str !== 'string') return 0;
            var value = str.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\./g, '');

            if (/^(noon|midday)$/.test(value)) return 12 * 60;
            if (value === 'midnight') return 0;

            var match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
            if (!match) return 0;

            var hours = parseInt(match[1], 10);
            var minutes = match[2] ? parseInt(match[2], 10) : 0;
            var meridiem = match[3];

            if (minutes > 59) return 0;

            if (meridiem) {
                if (hours < 1 || hours > 12) return 0;
                if (meridiem === 'pm' && hours !== 12) hours += 12;
                if (meridiem === 'am' && hours === 12) hours = 0; // 12:30 AM is 00:30
            } else if (hours > 23) {
                return 0;
            }

            return hours * 60 + minutes;
        },

        /**
         * "2 to 4 PM" - the meridiem belongs to both times. When the end time is
         * smaller than the start and carries no meridiem of its own, assume the
         * same half of the day (2 PM -> 4 PM, not 4 AM).
         */
        inferEndMeridiem: function (startRaw, endEntry, startMinutes) {
            var endValue = endEntry.minutes;
            if (/(am|pm)/i.test(endEntry.raw)) return endValue;
            if (/^(noon|midday|midnight)$/i.test(endEntry.raw)) return endValue;

            var startMeridiem = /pm/i.test(startRaw) ? 'pm' : (/am/i.test(startRaw) ? 'am' : '');
            var endMeridiem = /pm/i.test(endEntry.raw) ? 'pm' : (/am/i.test(endEntry.raw) ? 'am' : '');

            // Both times already carry a 24-hour clock ("14:00 to 09:00"): the text
            // is internally inconsistent, so it is left alone rather than shifted.
            if (!startMeridiem && !endMeridiem) return endValue;

            var startHours = Math.floor(startMinutes / 60);
            var endHours = Math.floor(endValue / 60);

            if (!startMeridiem) {
                // 24-hour start: keep the end after the start within the same day.
                if (endValue <= startMinutes && endValue + 12 * 60 > startMinutes) return endValue + 12 * 60;
                return endValue;
            }
            if (startMeridiem === 'pm' && startHours >= 12 && endHours < 12) return endValue + 12 * 60;
            if (startMeridiem === 'pm' && endHours < startHours) return endValue + 12 * 60;
            return endValue; // e.g. 9 AM - 11 AM stays in the morning
        },

        /* ------------------------------------------------------------------ *
         * Location and title
         * ------------------------------------------------------------------ */

        findLocation: function (lines) {
            for (var i = 0; i < lines.length; i++) {
                var labeled = lines[i].match(LOCATION_LABEL);
                if (labeled) {
                    var cleaned = this.cleanLocation(labeled[1]);
                    if (cleaned) return cleaned;
                }
            }

            var joined = lines.join(' ');
            var inline = joined.match(/\s(?:at|@|in)\s+([^,.;\n]+(?:,\s*[^,.;\n]+)*)/i);
            if (inline && !this.looksLikeDateTime(inline[1])) {
                var candidate = this.cleanLocation(inline[1]);
                if (candidate) return candidate;
            }

            var venue = joined.match(/\b(?:at|@)\s+([A-Z][\w'’&.-]*(?:\s+(?:[A-Z][\w'’&.-]*|of|the|and))*(?:\s+(?:Hotel|Hall|Center|Centre|Room|Office|Cafe|Café|Restaurant|Theatre|Theater|Stadium|Park|Arena|Convention|Library|School|College|University)\b)?)/);
            if (venue) {
                var venueValue = this.cleanLocation(venue[1]);
                if (venueValue) return venueValue;
            }

            return '';
        },

        /**
         * Is this candidate really just a date or a time, rather than a name?
         *
         * The dependable test is whether anything name-like survives once the date
         * and time phrases are removed:
         *
         *   "Thursday, November 12, 2026, from 09:00 AM to 05:00 PM"  -> date only
         *   "on 2026-05-01 at 10:00"                                  -> time only
         *   "Webinar 2026-04-08 15:00"                                -> keeps "Webinar"
         *
         * Only candidates without a sentence break are treated as possible
         * timestamps, so a long paragraph that merely mentions a time is never
         * mistaken for one.
         */
        looksLikeDateTime: function (value) {
            var trimmed = String(value).trim();
            if (!trimmed) return true;
            if (trimmed.length > 120 || /[.!?]\s/.test(trimmed)) return false;

            var left = this.stripEmbeddedDateAndTime(trimmed)
                .replace(/\b(?:at|on|in|from|to|by|for|with|of|the|a|an|and|until|till|starting|between)\b/gi, ' ')
                .replace(/\d+(?:st|nd|rd|th)?/gi, ' ') // stray day numbers, years, clock digits
                .replace(/[^A-Za-z]+/g, '');
            // Fewer than three letters left means the candidate was a timestamp, not
            // a name: "Webinar 2026-04-08 15:00" keeps "Webinar", while
            // "Friday, 18 December 2026, 7:00 PM" keeps nothing.
            return left.length <= 2;
        },

        cleanLocation: function (value) {
            if (!value) return '';
            var cleaned = String(value)
                .replace(/[ \t]+/g, ' ')
                .replace(/^[\s,;:\-–—>|]+/, '');
            // Stop where the location ends: at the next time, the next date, or the
            // next labelled field. Otherwise "... at The Ritz tomorrow at 3:30pm"
            // would swallow the whole rest of the sentence.
            cleaned = cleaned.split(TIME_FRAGMENT)[0];
            cleaned = cleaned.split(DATE_FRAGMENT)[0];
            cleaned = cleaned.split(/\s+(?=(?:Date|Time|When|Where|Description|Details|Price|Cost|Register|Tickets|Notes|Agenda)\b)/i)[0];
            cleaned = cleaned.split(/[.!?]\s+/)[0].split(/\s+[|•]\s+/)[0];
            cleaned = cleaned.replace(/[\s,;:\-–—]+$/, '').trim();
            if (cleaned.length < 2 || cleaned.length > 120) return '';
            if (this.looksLikeDateTime(cleaned)) return '';
            if (/^(?:the\s+)?(?:event|meeting|us|it|this|that|noon|midnight)$/i.test(cleaned)) return '';
            return cleaned;
        },

        findLabeledTitle: function (lines) {
            for (var i = 0; i < lines.length; i++) {
                var match = lines[i].match(TITLE_LABEL);
                if (match) {
                    var value = this.cleanTitle(match[1]);
                    if (value) return value;
                }
            }
            return '';
        },

        /** A link-only share still has a usable title in the URL slug. */
        titleFromUrl: function (url) {
            if (!url) return '';
            var match = String(url).match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
            if (!match) return '';
            var parts = (match[2] || '').split('/').filter(Boolean);
            var slug = parts.length > 0 ? parts[parts.length - 1] : match[1].replace(/^www\./i, '');
            slug = slug.replace(/\.(html?|php|aspx?|jsp)$/i, '').replace(/[-_+]+/g, ' ')
                .replace(/%[0-9a-f]{2}/gi, ' ').trim();
            if (!slug || /^\d+$/.test(slug)) return '';
            var title = this.cleanTitle(slug);
            if (!title || title.length < 4) return '';
            return title;
        },

        titleFromLines: function (lines) {
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].replace(/^[ \t>*_>-]+/, '').trim();
                if (!line) continue;
                if (this.isNoiseLine(line)) continue;
                var stripped = this.stripDateAndTime(line);
                if (stripped) {
                    var value = this.cleanTitle(stripped);
                    if (value) return value;
                }
                var fallback = this.cleanTitle(line);
                if (fallback) return fallback;
            }
            return '';
        },

        isNoiseLine: function (line) {
            var withoutUrls = line.replace(new RegExp(URL_PATTERN.source, 'gi'), '').trim();
            if (URL_PATTERN.test(line) && withoutUrls.length < 3) return true;
            if (/^(?:hi|hey|hello|dear)\b/i.test(line)) return true;
            // A whole line that is only a call to action carries no event name.
            if (/^(?:join us|join|click here|click|register now|register|book now|book|buy tickets|buy|save your spot|rsvp|view in browser|view)\s*[!.,:]?$/i.test(line)) return true;
            if (/^[ \t>*_>-]*(?:date|time|when|where|location|venue|address|description|details|price|cost|tickets?|notes|agenda|about|summary)\s*[:\-–]/i.test(line)) return true;
            if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(line)) return true;
            return false;
        },

        /** Remove a leading/trailing date or time so "March 3 - Team sync" -> "Team sync". */
        stripDateAndTime: function (line) {
            var value = line;
            value = value.replace(new RegExp('^\\s*(?:on\\s+)?(?:' + MONTH_PATTERN + ')\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\s*[-–—:|]*\\s*', 'i'), '');
            value = value.replace(/^\s*(?:on\s+)?\d{4}-\d{2}-\d{2}\s*[-–—:|]*\s*/, '');
            value = value.replace(/^\s*(?:on\s+)?\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\s*[-–—:|]*\s*/, '');
            value = value.replace(/^\s*(?:from|at|@)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:[-–—]|to|until|till)?\s*(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)?\s*[-–—:|]*\s*/i, '');
            value = value.replace(/\s*(?:from|at|@)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:[-–—]|to|until|till)?\s*(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)?\s*$/i, '');
            return value.replace(/\s*[-–—|]\s*$/, '').trim();
        },

        /**
         * Remove a date/time phrase that sits inside a sentence, e.g.
         * "... will take place on Thursday, November 12, 2026, from 09:00 AM to
         * 05:00 PM IST (with registration opening early at 08:15 AM). This ..."
         * -> "... will take place on . This ..."
         *
         * Only reached for long, sentence-like candidates, so a genuine title such
         * as "April 22 Planning" is never touched.
         */
        stripEmbeddedDateAndTime: function (value) {
            var months = '(?:' + MONTH_PATTERN + ')';
            var day = '\\d{1,2}(?:st|nd|rd|th)?';
            var year = '(?:,?\\s+\\d{4})';
            var time = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)';
            var out = String(value);

            // "(with registration opening early at 08:15 AM)" and similar asides
            out = out.replace(/\s*\([^()]{0,160}?(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?))[^()]{0,80}?\)/gi, ' ');

            var monthDay = new RegExp('(?:\\bon\\s+)?(?:[A-Z][a-z]+,\\s+)?' + months + '\\.?\\s+' + day + '(?:' + year + ')?', 'gi');
            var dayMonth = new RegExp('(?:\\bon\\s+)?' + day + '\\s+(?:of\\s+)?' + months + '\\.?(?:' + year + ')?', 'gi');
            var isoDate = /\b\d{4}-\d{1,2}-\d{1,2}\b/g;
            var numericDate = /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/g;
            var range = new RegExp('(?:,?\\s*(?:from|between)\\s+)?' + time + '\\s*(?:-|–|—|to|until|till|thru|through)\\s*' + time + '(?:\\s*[A-Z]{2,4}\\b)?', 'gi');
            // Standalone clock times, with or without a leading "at"/"from".
            var single = new RegExp('(?:,?\\s*(?:starting\\s+)?(?:at|from)\\s+)?' + time, 'gi');

            [monthDay, dayMonth, isoDate, numericDate, range, single].forEach(function (pattern) {
                out = out.replace(pattern, ' ');
            });

            // A bare weekday that is left over belongs to the date that was removed
            // ("Friday, 18 December 2026" -> "Friday,"), not to the event name.
            out = out.replace(/\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ');

            return out.replace(/\s{2,}/g, ' ').trim();
        },

        /**
         * Drop a date/time fragment left dangling at the end of a name:
         *   "Q3 2026 Planning on 2026-10-01" -> "Q3 2026 Planning"
         *   "Team sync at 09:00"             -> "Team sync"
         */
        trimDanglingDate: function (text) {
            var value = String(text);
            var fragment = '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{2,4}|(?:' + MONTH_PATTERN +
                ')\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?))';
            for (var pass = 0; pass < 3; pass++) {
                var before = value;
                value = value
                    .replace(new RegExp('[\\s,;:–—-]+(?:on|at|from|to|by|in|until|till|starting|between)?\\s*' + fragment + '[\\s,;:–—-]*$', 'i'), '')
                    .replace(/[\s,;:.!?–—-]+$/, '')
                    .replace(/\s+(?:on|at|in|from|to|by|for|with|of|the|a|an|and|until|till|starting|between)$/i, '')
                    .replace(/[\s,;:.!?–—-]+$/, '');
                if (value === before) break;
            }
            return value.trim();
        },

        /** Words that mean "the real name has already ended here". */
        TITLE_CUT_PATTERN: /[\s,;:–—-]+(?:will\s+(?:take\s+place|be\s+held|be\s+hosted|happen|start|begin|run|kick\s+off)|is\s+(?:taking\s+place|being\s+held|happening|scheduled|hosted|organised|organized|back)|takes\s+place|hosted\s+by|presented\s+by|organised\s+by|organized\s+by|brought\s+to\s+you\s+by|in\s+partnership\s+with|where\s+|which\s+|\bthat\s+|\bthis\s+|\bjoin\s+us\b|\bcome\s+|\battend\b|\bregister\b|\bplease\b|\btickets\b|\bfor\s+more\s+information\b|\bfor\s+details\b)/i,
        /**
         * Trim a paragraph down to the event name: drop an embedded date/time, then
         * cut at the first clause that talks about the event rather than naming it.
         */
        trimToTitle: function (value) {
            var text = String(value).trim();
            if (text.length <= 40) return this.trimDanglingDate(text);

            text = this.stripEmbeddedDateAndTime(text).replace(/\s{2,}/g, ' ').trim();

            var cut = text.search(this.TITLE_CUT_PATTERN);
            if (cut > 1) text = text.slice(0, cut);

            text = text.split(/[.!?]\s+/)[0];
            // A long candidate with no sentence break is better cut at the first
            // comma than shown as a wall of text.
            if (text.length > 90 && text.indexOf(',') > 8) {
                text = text.slice(0, text.indexOf(','));
            }

            return this.trimDanglingDate(text);
        },

        cleanTitle: function (value) {
            if (!value) return '';
            var title = String(value)
                .replace(/^[\s>*_\-–—•|]+/, '')
                .replace(/[\s>*_\-–—•|]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            title = this.trimToTitle(title);
            title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
            if (title.length < 2) return '';
            if (title.length > 140) title = title.slice(0, 140).trim();
            if (this.looksLikeDateTime(title)) return '';
            if (/^(?:am|pm|note|notes)$/i.test(title)) return '';
            return title;
        }
    };

    root.Extractor = Extractor;

    if (typeof module === 'object' && module.exports) module.exports = Extractor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
