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
    // "2 to 4 PM" / "9-11am" / "starts at 8 AM and ends at 11:30 AM": the meridiem
    // written once at the end of a range applies to both times. Bare hours are only
    // matched when a range connector proves they are times, never on their own.
    // "2 to 4 PM" / "starts at 8 AM and finishes at 11:30 AM": the meridiem written
    // once at the end of a range belongs to both times. The middle may only be a range
    // separator, never arbitrary text, so a complete time ("9:30 AM to 4:00 PM") is
    // left exactly as it is.
    var RANGE_MIDDLE = '\\s*(?:-|–|—|to|until|till|thru|through)\\s*'
        + '|\\s*(?:,?\\s*and\\s+)?(?:finishes|ends|closes)\\s+at\\s+'
        + '|\\s*(?:,|and)\\s*';
    var BARE_RANGE_PATTERN = new RegExp(
        '(?<![\\d:])(\\d{1,2})(?![\\d:/\\-–—.])((?:' + RANGE_MIDDLE + '))(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?))(?![\\d/\\-–—])',
        'gi'
    );
    // Where a location usually stops: the next time, date or labelled field.
    var TIME_FRAGMENT = /(?:\b(?:at|@|from)\s*)?(?:\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|\bnoo?n\b|\bmidnight\b|\b\d{1,2}(?::\d{2})?\s*(?:-|–|—|to|until|till)\s*\d{1,2})/i;
    var DATE_FRAGMENT = new RegExp('\\b(?:today|tonight|tomorrow|tmrw|tmw|yesterday|next\\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\\s+(?:week|weekend|month|year)|on\\s+(?:' + MONTH_PATTERN + '|\\d)|(?:' + MONTH_PATTERN + ')\\s+\\d|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})', 'i');
    var LOCATION_LABEL = /^[ \t>*_>-]*(?:location|where|venue|address|place)\s*[:\-–]\s*(.+)$/i;
    var TITLE_LABEL = /^[ \t>*_>-]*(?:event(?:\s*name)?|title|subject|summary|meeting|webinar|session)\s*[:\-–]\s*(.+)$/i;

    // A zero-minute time is only spurious when it is NOT a real midnight form.
    // Accepts: "midnight", "12 AM", "12:00 AM", "12am", "12:00am", "00:00",
    // "0:00" - any of the ways a writer can spell the start of the day.
    var MIDNIGHT_RAW = /^(?:midnight|12(?::00)?\s*a\.?m\.?|0?0:00)$/i;

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
         * @param {object} [options.page] Structured data from a fetched web page
         *                               (see js/urlfetch.js parseHtml): title,
         *                               startDate, endDate, location, description.
         *                               Values published by the page in schema.org
         *                               JSON-LD are exact, so they win over anything
         *                               guessed from the visible text.
         * @returns {null|object} null when there is no usable text at all.
         */
        extract: function (text, options) {
            if (typeof text !== 'string' || text.trim() === '') return null;

            var now = (options && options.now instanceof Date) ? options.now : new Date();
            var page = (options && options.page) || null;
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
            var urlTitle = !lineTitle ? this.titleFromUrl(urls[0]) : '';
            var title = lineTitle || urlTitle;

            var details = {
                title: title || '',
                date: parsedDate ? this.formatDate(parsedDate.date) : '',
                startTime: timeInfo.start || '',
                endTime: timeInfo.end || '',
                // True when the end time belongs to the following day, e.g. a party that
                // runs "from noon until midnight".
                endNextDay: !!timeInfo.endNextDay,
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
                title: labeledTitle ? 'label' : (lineTitle ? 'line' : (urlTitle ? 'url' : '')),
                date: parsedDate ? parsedDate.matched : '',
                startTime: timeInfo.startMatched || '',
                endTime: timeInfo.endMatched || '',
                location: location ? 'text' : '',
                relative: parsedDate ? !!parsedDate.relative : false,
                fromLabel: !!labeledTitle,
                dateFromText: !!parsedDate,
                timeFromText: !!timeInfo.start,
                locationFromText: !!location
            };

            if (page) this.applyPageData(details, page, now, !!labeledTitle);

            details.missing = this.findMissing(details);
            return details;
        },

        /**
         * Overlay what the page itself declared.
         *
         * A page's own JSON-LD (schema.org Event) is authoritative: it is the event's
         * real start and end, not an interpretation of a sentence. It only fills a
         * field, never overwrites a value the text already gave, and a date that is a
         * run ("Sat 14 Nov 2026 - Sat 9 Jan 2027") still leaves the time for the user.
         */
        applyPageData: function (details, page, now, hasLabeledTitle) {
            var self = this;

            /** "2026-11-14T19:00:00+05:30" or "2026-11-14" -> local date and time parts. */
            var splitStamp = function (value) {
                var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
                if (!match) return null;
                var local = new Date(
                    parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10),
                    match[4] ? parseInt(match[4], 10) : 0, match[5] ? parseInt(match[5], 10) : 0, 0, 0
                );
                if (isNaN(local.getTime())) return null;
                return {
                    date: self.formatDate(local),
                    time: match[4] ? self.to24Hour(match[4], match[5]) : '',
                    hasTime: !!match[4]
                };
            };

            var starts = splitStamp(page.startDate);

            // A reader page states its facts as plain text instead of structured data:
            // "Sat 14 Nov 2026 - Sat 9 Jan 2027" and "7:00 PM". Those are exact, so they
            // are used before the general text scan, which navigation can mislead.
            if (!starts && page.dateText) {
                var fromFacts = this.findDate(page.dateText, now);
                if (fromFacts) {
                    starts = { date: this.formatDate(fromFacts.date), time: '', hasTime: false };
                    details.sources.dateFromPageFacts = true;
                }
            }
            if (starts && !details.startTime && page.timeOfDay) {
                var pageTimeRaw = String(page.timeOfDay).trim();
                var pageTime = this.parseTime(pageTimeRaw);
                // A page that declares "12:00 AM" or "00:00" is just as exact as one
                // that spells "midnight"; accept every zero-minute midnight form.
                if (pageTime || MIDNIGHT_RAW.test(pageTimeRaw)) {
                    details.startTime = this.to24Hour(Math.floor(pageTime / 60), pageTime % 60);
                    details.sources.startTime = 'page';
                }
            }

            var ends = splitStamp(page.endDate);
            if (ends && !details.endTime && ends.hasTime && ends.date === (details.date || (starts && starts.date))) {
                details.endTime = ends.time;
                details.sources.endTime = 'page';
            } else if (ends && starts && !details.endTime && ends.hasTime) {
                // An end on a later day: the .ics and Google Calendar both need it.
                details.endDate = ends.date;
                details.endTime = ends.time;
                details.endNextDay = true;
                details.sources.endTime = 'page';
            }

            // Title ranking, strongest first:
            //   1. a label the user's own text carries ("Event: Design Review")
            //   2. the title the page published (og:title / schema.org name), which is
            //      written for the event and cannot pick up page navigation
            //   3. the first usable line of text, stripped of any embedded date
            //      ("Winter Craft Fair 5" from a page is why 2 outranks 3)
            if (page.title && String(page.title).trim().length >= 3) {
                var publishedTitle = String(page.title).trim();
                if (!hasLabeledTitle) {
                    details.title = publishedTitle;
                    details.sources.title = 'page';
                    // The "label" the line scanner found was the reader's own "Title:"
                    // preamble, not the user naming the event, so a date the user typed
                    // must not lose to the page's date on the strength of it.
                    details.sources.fromLabel = false;
                } else {
                    // The user's text named the event explicitly; keep that name but
                    // note that the page agreed on something.
                    details.sources.pageTitle = publishedTitle;
                }
            }

            // Date precedence, decided after the title: what the page states beats what a
            // sentence scan guessed, because a page is full of dates that are not the
            // event (a banner image timestamp supplied 2026-10-11 for a November show).
            // A date the user labelled by hand is never overridden.
            if (starts) {
                var pageDateWins = !details.date || (details.sources.dateFromText && !details.sources.fromLabel);
                if (pageDateWins) {
                    details.date = starts.date;
                    details.sources.date = 'page';
                    details.sources.dateFromText = false;
                }
                if (!details.startTime && starts.hasTime) {
                    details.startTime = starts.time;
                    details.sources.startTime = 'page';
                }
            }

            // A venue the page states ("Sophia Bhabha Auditorium, Mumbai") is a real
            // place; a phrase read out of page text can be navigation ("Kochi Book Your
            // Calender Events happening"). The page value wins when the text one looks
            // like noise rather than a venue.
            if (page.location && details.sources.locationFromText) {
                var textLocation = String(details.location || '');
                var looksLikeNoise = !/\b(?:club|hall|centre|center|theatre|theater|auditorium|arena|stadium|park|rooms?|office|studio|gallery|museum|library|hotel|restaurant|cafe|bar|lounge|auditorium|convention|academy|campus|school|college|university|gardens?|palace|mill|rooftop)\b/i.test(textLocation) ||
                    textLocation.split(/\s+/).length > 8 ||
                    /(?:https?|\]\(|happening|calender|calendar|today|tomorrow|sign in)/i.test(textLocation);
                if (looksLikeNoise) {
                    details.location = page.location;
                    details.sources.location = 'page';
                }
            } else if (page.location && !details.location) {
                details.location = page.location;
                details.sources.location = 'page';
            }

            // The description for a link input.
            //
            // A page's own write-up is written for the event, so it is the right calendar
            // description. When the page offers none, the prose already selected out of
            // the page is used. A raw page capture is never pasted in whole: that put
            // menus, search keywords and the site's footer into the user's calendar entry.
            if (page.description && page.description.length >= 40) {
                details.description = page.description;
                details.sources.description = 'page';
            } else {
                // Keep only the part of the page that reads as writing, closed at a full
                // stop. When nothing does, the description is left empty rather than
                // filled with menus.
                var prose = (typeof UrlFetch === 'object' && UrlFetch && UrlFetch.proseFrom)
                    ? UrlFetch.proseFrom(details.description, 1400)
                    : '';
                details.description = prose || '';
                if (prose) details.sources.description = 'page-prose';
            }

            details.pageSource = page.source || '';
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

            /** Adds one parsed time, ignoring duplicates and unparseable values. */
            function add(minutes, raw, start, end) {
                // A zero-minute value is only spurious when it is not a real
                // midnight form. "12:00 AM", "12 AM", "00:00" and "midnight"
                // all mean 00:00 and must be kept; anything else that parses to
                // zero ("", "abc") is dropped.
                if (!minutes && !MIDNIGHT_RAW.test(raw)) return;
                if (found.some(function (entry) { return entry.minutes === minutes; })) return;
                found.push({
                    minutes: minutes,
                    value: self.to24Hour(Math.floor(minutes / 60), minutes % 60),
                    raw: raw,
                    start: start,
                    end: end
                });
            }

            // A range whose end is a word: "noon until midnight", "9:00 PM to midnight".
            // Checked first, because those two times must stay paired.
            var keywordRange = /(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midday|midnight)\s*(?:-|–|—|to|until|till|thru|through)\s*(noon|midday|midnight)/i;
            var wordRange = normalized.match(keywordRange);
            if (wordRange) {
                var head = wordRange[0].slice(0, wordRange[0].length - wordRange[1].length)
                    .replace(/\s*(?:-|–|—|to|until|till|thru|through)\s*$/i, '').trim();
                var startMinutes = this.parseTime(head);
                var endMinutes = /^midnight$/i.test(wordRange[1]) ? 0 : 12 * 60;
                var offset = wordRange.index;

                if (startMinutes || /^midnight$/i.test(head)) {
                    add(startMinutes, head, offset, offset + head.length);
                    add(endMinutes, wordRange[1], offset + wordRange[0].length - wordRange[1].length,
                        offset + wordRange[0].length);
                }
            }

            TIME_PATTERN.lastIndex = 0;
            if (found.length === 0) {
                while ((match = TIME_PATTERN.exec(normalized)) !== null) {
                    // Trim sentence punctuation the pattern may have absorbed ("2 PM.").
                    var raw = match[0].trim().replace(/[.,;:!?]+$/, '');
                    if (!raw) continue;
                    add(this.parseTime(raw), raw, match.index, match.index + match[0].length);
                    if (found.length >= 6) break;
                }
            }

            if (found.length === 0) return { start: '', end: '', times: [] };

            var result = {
                start: found[0].value,
                startMatched: found[0].raw,
                end: '',
                endMatched: '',
                endNextDay: false,
                times: found.map(function (entry) { return entry.value; })
            };

            if (found.length > 1) {
                var between = normalized.slice(found[0].end, found[1].start);
                var isRange = found[1].keyword ||
                    SEPARATOR_PATTERN.test(between) ||
                    /(?:finishes|ends|closes)\s+at\s*$/i.test(between) ||
                    TIME_TAIL_PATTERN.test(found[0].raw) ||
                    TIME_TAIL_PATTERN.test(between);
                if (isRange) {
                    var endMinutes = self.inferEndMeridiem(found[0].raw, found[1], found[0].minutes);
                    // A range ending at the word "midnight" finishes at the end of that
                    // day, not at its start, so the guard must not treat it as too early.
                    // Only the word counts: an explicit "00:30" is a real clock time.
                    var wraps = endMinutes === 24 * 60 || /^midnight$/i.test(found[1].raw);
                    if (wraps || endMinutes > found[0].minutes) {
                        var endValue = wraps ? 0 : endMinutes;
                        result.end = self.to24Hour(Math.floor(endValue / 60), endValue % 60);
                        result.endMatched = found[1].raw;
                        result.endNextDay = wraps;
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
            // "2 to 4 PM" and "starts at 8 AM and finishes at 11:30 AM" both describe a
            // range, so the meridiem written once at the end is copied onto the start.
            // The separator is only accepted when it really connects two times, so an
            // unrelated pair of numbers is left untouched.
            return String(text).replace(BARE_RANGE_PATTERN, function (whole, first, between, end) {
                var isRange = /^\s*(?:-|–|—|to|until|till|thru|through)\s*$/i.test(between) ||
                    /(?:-|–|—|to|until|till|thru|through)\s*$/i.test(between) ||
                    /(?:finishes|ends|closes|until|till|through|thru)\s+at\s*$/i.test(between) ||
                    /^\s*(?:and|,)\s*(?:finishes|ends|closes)\s+at\s*$/i.test(between);
                if (!isRange) return whole;

                var meridiem = (end.match(/(?:a|p)\.?m\.?/i) || [''])[0];
                var startHasMeridiem = /(?:a|p)\.?m\.?/i.test(first);
                return first + (startHasMeridiem || !meridiem ? '' : ' ' + meridiem) + between + end;
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

            // "noon until midnight" / "from noon to midnight": midnight ends the day,
            // so the event finishes 24 hours after the start of the day, not at its start.
            if (/^(noon|midday)$/i.test(startRaw) && /^midnight$/i.test(endEntry.raw)) {
                return 24 * 60;
            }
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

            // Look at every "at" / "in" / "@" and prefer the last usable one: the first
            // often introduces a time ("... at 4:30 PM in Meeting Room 2"), which is not
            // a location.
            var joined = lines.join(' ');
            var marker = /\s(?:at|@|in)\s+/gi;
            var candidates = [];
            var found;
            while ((found = marker.exec(joined)) !== null) {
                candidates.push(joined.slice(marker.lastIndex, marker.lastIndex + 140));
            }

            for (var c = candidates.length - 1; c >= 0; c--) {
                var head = candidates[c].split(/[.;\n]/)[0];
                if (this.looksLikeDateTime(head)) continue;
                var candidate = this.cleanLocation(head);
                if (candidate) return candidate;
            }

            // A venue often sits on its own line, with no "at" or "in" in front of it:
            // "The Comedy Club, Mumbai". It must name a kind of place, which keeps
            // category lines such as "Stand up Comedy, Comedy Shows" out.
            var venueWords = /\b(?:club|hall|centre|center|theatre|theater|auditorium|arena|stadium|ground|grounds|park|room|rooms|office|studio|gallery|museum|library|hotel|resort|restaurant|cafe|café|bar|pub|lounge|mall|convention|academy|institute|campus|school|college|university|church|temple|mosque|marina|pavilion|gardens?|palace|castle|mill|warehouse|loft|rooftop|banquet|amphitheatre|amphitheater)\b/i;
            for (var v = 0; v < lines.length; v++) {
                var venueLine = lines[v].replace(/^[#*>\s-]+/, '').trim();
                if (!/,\s*[A-Z]/.test(venueLine)) continue;
                if (venueLine.length > 80 || venueLine.split(/\s+/).length > 8) continue;
                if (/\d{1,2}:\d{2}|[.!?]|\b(?:at|on|from|until)\b/i.test(venueLine)) continue;
                if (!venueWords.test(venueLine)) continue;
                var venueCandidate = this.cleanLocation(venueLine);
                if (venueCandidate) return venueCandidate;
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
            // Stop at the clause that starts describing the address rather than naming
            // the place: "The Grand Ballroom inside the ITC Grand Chola, located at No. 63".
            cleaned = cleaned.split(/\s+(?:inside|within|located\s+at|at\s+No\.?|which\s+is)\b/i)[0];
            cleaned = cleaned.split(/\s+(?=(?:Date|Time|When|Where|Description|Details|Price|Cost|Register|Tickets|Notes|Agenda)\b)/i)[0];
            cleaned = cleaned.split(/[.!?]\s+/)[0].split(/\s+[|•]\s+/)[0];
            cleaned = cleaned.replace(/[\s,;:\-–—]+$/, '').trim();
            if (cleaned.length < 2 || cleaned.length > 120) return '';
            if (this.looksLikeDateTime(cleaned)) return '';
            if (/^(?:the\s+)?(?:event|meeting|us|it|this|that|noon|midnight)$/i.test(cleaned)) return '';
            // A place has a place word or reads as a proper name. This keeps descriptive
            // prose out: a page about a domain once supplied "documentation examples
            // without needing permission" as the venue.
            var placeWord = /\b(?:club|hall|centre|center|theatre|theater|auditorium|arena|stadium|grounds?|park|rooms?|office|studio|gallery|museum|library|hotel|resort|restaurant|cafe|café|bar|pub|lounge|mall|convention|academy|institute|campus|school|college|university|church|temple|mosque|marina|pavilion|gardens?|palace|mill|warehouse|rooftop|banquet|society|sabha|bhavan|bhawan|kendra|maidan|building|tower|plaza|street|road|avenue|lane|square|city|nagar|puram|colony|sector|airport|station|campus)\b/i;
            var looksProper = /(?:^|[\s,(])[A-Z]/.test(cleaned) &&
                cleaned.split(/\s+/).length <= 6 &&
                !/\b(?:without|needing|permission|available|visit|learn|read|find|use|using|see|about|here|more)\b/i.test(cleaned);
            if (!placeWord.test(cleaned) && !looksProper) return '';
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
        /** Stop words: a year behind one of these belongs to a date, not to a name. */
        YEAR_STOP_WORDS: ['on', 'at', 'in', 'from', 'to', 'until', 'till', 'by', 'for', 'of', 'the', 'a', 'an',
            'and', 'or', 'is', 'are', 'was', 'will', 'be', 'held', 'starts', 'ends', 'finishes', 'closes',
            'runs', 'starting', 'between', 'every', 'during', 'after', 'before',
            'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
            'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
            'october', 'november', 'december',
            'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'],

        /**
         * Does the year at `index` belong to the event name rather than to a date?
         *   "... AI & Tech Summit 2026 will take place on Thursday, November 12, 2026"
         *        ^ name                                     ^ date
         * The year is part of the name when the word in front of it is a real word:
         * "Summit 2026" and "Q3 2026" keep it, while "on 2026", "November 12, 2026"
         * and "2026-10-01" do not.
         */
        yearBelongsToName: function (text, index) {
            var before = String(text).slice(0, index);
            var word = (before.replace(/\s+$/, '').split(/\s+/).pop() || '').toLowerCase();
            if (!word) return false;
            if (this.YEAR_STOP_WORDS.indexOf(word) !== -1) return false;
            if (/^\d+$/.test(word)) return false;        // "12" from "November 12, 2026"
            if (/[a-z]\d{1,2}$/.test(word)) return true; // "Q3", "TechFest2026"
            if (word.length < 3) return false;
            if (/[-\/.,]\s*$/.test(before)) return false; // "2026," or "2026-04"
            return true;
        },

        /** All 4-digit years that must be preserved because they name the event. */
        nameYearsIn: function (text) {
            var out = [];
            var pattern = /(?<![0-9-])[0-9]{4}(?![0-9-])/g;
            var match;
            while ((match = pattern.exec(String(text))) !== null) {
                if (this.yearBelongsToName(text, match.index)) out.push(match[0]);
            }
            return out;
        },

        /**
         * Remove a date/time phrase that sits inside a sentence, e.g.
         * "... will take place on Thursday, November 12, 2026, from 09:00 AM to
         * 05:00 PM IST (with registration opening early at 08:15 AM). This ..."
         * -> "... will take place. This ..."
         *
         * Only reached for long, sentence-like candidates, so a genuine title such
         * as "April 22 Planning" is never touched.
         */
        stripEmbeddedDateAndTime: function (value) {
            var months = '(?:' + MONTH_PATTERN + ')';
            var day = '\\d{1,2}(?:st|nd|rd|th)?';
            var year = '\\d{4}';
            // A real clock time: minutes or a meridiem are required. A bare number is
            // never matched on its own, or it would eat digits out of years and names.
            var clock = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)';
            var connector = '(?:-|–|—|to|until|till|thru|through)';
            var keyword = '(?:noon|midday|midnight)';
            var out = String(value);

            // Hide the years that belong to the name, so no date rule can remove them.
            // The marker carries the year itself, so it survives whatever reordering
            // the later rules do.
            out = out.replace(/(?<![0-9-])[0-9]{4}(?![0-9-])/g, function (found, offset) {
                if (!Extractor.yearBelongsToName(value, offset)) return found;
                return '\u0001' + found + '\u0001';
            });

            // Parenthesised asides: "(doors open at 06:30 PM)", "(please register 10
            // minutes early)".
            out = out.replace(/\s*\([^()]{0,200}?\)/g, ' ');

            // Month-name dates, either order, with optional day and year. Run twice: one
            // replacement can leave a second date-shaped remnant ("12 July 2026" -> "12 " + a leftover year) that only the repeat will catch.
            var monthFirst = new RegExp('(?:\\bon\\s+)?[\\s,;:(]*' + months + '\\.?\\s+' + day + '(?:,?\\s+\\d{4})?', 'gi');
            var dayFirst = new RegExp('(?:\\bon\\s+)?[\\s,;:(]*' + day + '\\s+(?:of\\s+)?' + months + '\\.?(?:,?\\s+\\d{4})?', 'gi');
            out = out.replace(monthFirst, ' ').replace(dayFirst, ' ');
            out = out.replace(monthFirst, ' ').replace(dayFirst, ' ');
            out = out.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ');
            out = out.replace(/\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/g, ' ');

            // Times. Bare-hour ranges are matched while their shape is intact, so
            // "from 2 to 4 PM" is removed whole instead of leaving "to" behind.
            out = out.replace(new RegExp('(?:,?\\s*(?:from|between)\\s+)?\\d{1,2}\\s*' + connector + '\\s*\\d{1,2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)', 'gi'), ' ');
            out = out.replace(new RegExp('(?:,?\\s*(?:from|between)\\s+)?' + clock + '\\s*' + connector + '\\s*' + clock + '(?:\\s*[A-Z]{2,4}\\b)?', 'gi'), ' ');
            // A keyword on either side: "noon until midnight", "9:00 PM until midnight".
            out = out.replace(new RegExp('(?:,?\\s*(?:from|between)\\s+)?' + clock + '\\s*' + connector + '\\s*' + keyword, 'gi'), ' ');
            out = out.replace(new RegExp('(?:,?\\s*(?:from|between)\\s+)?' + keyword + '\\s*' + connector + '\\s*(?:' + clock + '|' + keyword + ')', 'gi'), ' ');
            out = out.replace(new RegExp('(?:\\s*(?:,?\\s*and\\s+)?(?:finishes|ends|closes|runs)\\s+at\\s+)' + clock, 'gi'), ' ');
            out = out.replace(new RegExp('(?:,?\\s*(?:starting\\s+)?(?:at|from)\\s+)?' + clock, 'gi'), ' ');

            // Relative day words and weekday names belong to the date, not to the name.
            out = out.replace(/\b(?:today|tonight|tomorrow|tmrw|tmw|yesterday|this\s+(?:morning|afternoon|evening|week|weekend|month)|next\s+(?:week|month|year)|day\s+after\s+tomorrow)\b/gi, ' ');
            out = out.replace(/\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, ' ');

            // A day number left over from a month-name date: only when a month name was
            // present, and only when the number sits directly against it. A number that
            // belongs to the name ("Meeting Room 2", "Q3 2026") is left alone.
            if (new RegExp('\\b' + months + '\\b', 'i').test(value)) {
                out = out.replace(/^\s*\d{1,2}(?:st|nd|rd|th)?\b/, ' ');           // "4 October"
                out = out.replace(new RegExp('\\b' + day + '\\s*(?=$|[,.;:!?])', 'g'), ' '); // "October 4."
                // Numbers left behind once the month name went ("... Party, 12 26 at ...").
                // New text boundaries protect numbers that belong to the name.
                out = out.replace(/(^|[,.;:!?]\s*)\d{1,2}\s+\d{4}(?=\s|[,.;:!?]|$)/g, '$1');
                out = out.replace(/\s+\d{1,2}(?=\s+(?:at|on|in|from|to)\b)/gi, ' ');
            }

            // Tidy the gaps: doubled spaces, spaces before punctuation, orphan commas,
            // and a chain of prepositions or connectors left without an object
            // ("... on at .", "... on from"). Removing one word can strand the next, so
            // this repeats until the text stops changing.
            var previous = null;
            var tidy = new RegExp(
                '\\s*\\b(?:on|at|in|from|until|till|starting|between|and|the|a|an|of|to|come|join|meet)\\b\\s*(?=[,.;:!?]|$)', 'gi');
            for (var pass = 0; pass < 8 && out !== previous; pass++) {
                previous = out;
                out = out
                    .replace(/\s{2,}/g, ' ')
                    .replace(/\s+([,.;:!?])/g, '$1')
                    .replace(/,\s*(?=[,.;:!?])/g, '')
                    .replace(tidy, ' ');
            }

            // Bring the protected years back.
            out = out.replace(/\u0001\s*(\d{4})\s*\u0001/g, '$1');

            // Last pass over leftovers that the removal rules created between them:
            // a day number orphaned by its month ("... Party, 12 at the Gardens"), a day
            // waiting in front of one, an hour orphaned by its own minutes
            // ("9:00 PM until midnight" -> "9 until midnight"), and the connector left
            // where a keyword used to be.
            out = out.replace(new RegExp('\\s*\\b' + connector + '\\b\\s*(?=' + keyword + ')', 'gi'), ' ');
            out = out.replace(/\s+\d{1,2}(?=\s+(?:at|on|in)\b)/gi, ' ');
            out = out.replace(/(\bon|\bfrom|\bat)\s+\d{1,2}\s+(?=[A-Z])/g, '$1 ');

            return out
                .replace(/^[\s,;:–—-]+/, '')
                .replace(/[\s,;:–—-]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
        },

        /**
         * Drop a date/time fragment left dangling at the end of a name:
         *   "Q3 2026 Planning on 2026-10-01" -> "Q3 2026 Planning"
         *   "Team sync at 09:00"             -> "Team sync"
         */
        trimDanglingDate: function (text) {
            var value = String(text);
            var months = '(?:' + MONTH_PATTERN + ')';
            var day = '\\d{1,2}(?:st|nd|rd|th)?';
            // A real clock time: either minutes ("15:00") or a meridiem ("3 PM") is
            // required. A bare number is never matched on its own, or it would eat
            // digits out of years and names.
            var clock = '(?:\\d{1,2}:\\d{2}|\\d{1,2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?))';
            var connector = '(?:-|–|—|to|until|till|thru|through)';
            // Any date or time phrase, in the forms the extractor understands.
            var fragment = '(?:' + [
                '\\d{4}-\\d{1,2}-\\d{1,2}',
                '\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{2,4}',
                '\\d{1,2}\\s*' + connector + '\\s*\\d{1,2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)',
                months + '\\.?\\s+' + day + '(?:,?\\s+\\d{4})?',
                day + '\\s+(?:of\\s+)?' + months + '\\.?(?:,?\\s+\\d{4})?',
                clock + '\\s*' + connector + '\\s*' + clock,
                '(?:noon|midday|midnight)\\s*' + connector + '\\s*(?:noon|midday|midnight)',
                clock
            ].join('|') + ')';

            for (var pass = 0; pass < 4; pass++) {
                var before = value;
                value = value
                    // A fragment anywhere, not only at the end: the date and time are
                    // extracted separately, so a leftover one in the name is debris.
                    .replace(new RegExp('[\\s,;:–—-]*(?:on|at|from|to|by|in|until|till|starting|between)\\s*' + fragment, 'gi'), ' ')
                    .replace(new RegExp('[\\s,;:–—-]*' + fragment + '[\\s,;:–—-]*(?:on|at|from|to|by|in|until|till|starting|between)?\\s*$', 'i'), '')
                    .replace(/[\s,;:.!?–—-]+$/, '')
                    .replace(/\s+(?:on|at|in|from|to|by|for|with|of|the|a|an|and|until|till|starting|between)$/i, '')
                    .replace(/[\s,;:.!?–—-]+$/, '')
                    .replace(/\s{2,}/g, ' ');
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

            // Cut at the end of the first sentence, then at the first comma when what is
            // left is still long: a name is a phrase, not a paragraph.
            text = text.split(/[.!?]\s+/)[0];
            if (text.length > 90 && text.indexOf(',') > 8) {
                text = text.slice(0, text.indexOf(','));
            }

            // Anything from the first comma that follows a date/time fragment is
            // description, not name ("... on 2026-11-05 from 2 to 4 PM, come and meet").
            text = text.split(/,\s*(?=[a-z])/)[0];

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
