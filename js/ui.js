/**
 * CalSnap - user interface.
 *
 * This file only wires the DOM to the three logic modules:
 *   js/extractor.js   text    -> event details
 *   js/validation.js  details -> errors/warnings
 *   js/calendar.js    details -> Google Calendar URL / .ics document
 *
 * It never claims that an event has been saved: CalSnap prepares the event, and
 * the destination calendar application is the only thing that can create it.
 */
(function () {
    'use strict';

    /**
     * Shown in the footer. If this number is not the version you expect, the
     * browser is running a cached copy of the code - see the README section on
     * updating a deployed copy.
     */
    var APP_VERSION = '1.1.2';

    var SHARED_PARAM_NAMES = ['text', 'title', 'url', 'share', 'description'];
    var TEXT_FIELDS = ['title', 'date', 'startTime', 'endTime', 'location', 'description', 'reminder'];
    var MISSING_TEXT = {
        title: 'title',
        date: 'date',
        startTime: 'start time'
    };

    document.addEventListener('DOMContentLoaded', function () {
        var el = {
            rawText: document.getElementById('raw-text'),
            btnExtract: document.getElementById('btn-extract'),
            btnText: document.getElementById('btn-text'),
            inputSection: document.getElementById('input-section'),
            reviewSection: document.getElementById('review-section'),
            extractionNotice: document.getElementById('extraction-notice'),
            extractionHint: document.getElementById('extraction-hint'),
            form: document.getElementById('event-form'),
            title: document.getElementById('event-title'),
            date: document.getElementById('event-date'),
            start: document.getElementById('event-start'),
            end: document.getElementById('event-end'),
            location: document.getElementById('event-location'),
            description: document.getElementById('event-desc'),
            reminder: document.getElementById('event-reminder'),
            btnBack: document.getElementById('btn-back'),
            btnGoogle: document.getElementById('btn-google'),
            btnIcs: document.getElementById('btn-ics'),
            btnShare: document.getElementById('btn-share'),
            status: document.getElementById('status')
        };

        /* ------------------------------------------------------------------ *
         * Shared content (Steps 9 and 10, and the PWA share target)
         * ------------------------------------------------------------------ */

        var shared = readSharedInput();
        if (shared.text) {
            el.rawText.value = shared.text;
            if (shared.fromShare) runExtraction();
        }

        el.btnExtract.addEventListener('click', runExtraction);
        el.btnBack.addEventListener('click', showInput);
        el.btnGoogle.addEventListener('click', handleGoogle);
        el.btnIcs.addEventListener('click', handleDownload);
        el.btnShare.addEventListener('click', handleShare);
        el.rawText.addEventListener('keydown', function (event) {
            // Ctrl/Cmd+Enter extracts without reaching for the mouse.
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                runExtraction();
            }
        });
        el.form.addEventListener('input', clearFieldMarks);

        if ('serviceWorker' in navigator && location.protocol !== 'file:') {
            // './sw.js' (not 'sw.js') keeps the scope correct when the app is served
            // from a sub-path such as https://user.github.io/calsnap/.
            navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () { /* not user-facing */ });
        }

        var versionLabel = document.getElementById('app-version');
        if (versionLabel) versionLabel.textContent = 'Version ' + APP_VERSION;

        /* ------------------------------------------------------------------ *
         * Extraction
         * ------------------------------------------------------------------ */

        function readSharedInput() {
            var params = new URLSearchParams(window.location.search);
            var parts = [];

            SHARED_PARAM_NAMES.forEach(function (name) {
                var value = params.get(name);
                if (!value) return;
                var trimmed = value.trim();
                if (trimmed && parts.indexOf(trimmed) === -1) parts.push(trimmed);
            });

            if (!parts.length) return { text: '', fromShare: false };
            return { text: parts.join('\n'), fromShare: true };
        }

        /**
         * Read the page behind a link, then extract from it.
         *
         * A browser cannot read another origin's page (CORS, and many event sites
         * answer 403 anyway), so UrlFetch tries several routes and reports honestly
         * when every one fails instead of pretending the page was read.
         */
        function runUrlExtraction(url) {
            var button = el.btnExtract;
            var originalLabel = el.btnText.textContent;
            button.disabled = true;
            el.btnText.textContent = 'Reading the page...';
            showNotice(el.extractionNotice, 'Fetching ' + url + ' ...', 'info');

            return UrlFetch.load(url).then(function (result) {
                if (!result.ok) {
                    showNotice(el.extractionNotice, result.reason, 'warning');
                    return;
                }

                var page = result.page || {};
                var pageText = page.text || '';
                // The title is worth keeping even when the body is thin, so it is
                // prepended: the extractor then sees a line it can use as the name.
                var combined = (page.title ? page.title + '\n' : '') + pageText;
                var extracted = Extractor.extract(combined, { page: page });

                if (!extracted || (!extracted.title && !extracted.date)) {
                    showNotice(el.extractionNotice,
                        'The page was reached but no event details could be read from it. ' +
                        'Open the page, copy the event text and paste it here instead.',
                        'warning');
                    return;
                }

                fillForm(extracted);
                showReview();
                showHint(extracted);

                var found = [];
                if (extracted.title) found.push('title');
                if (extracted.date) found.push('date');
                if (extracted.startTime) found.push('start time');
                if (extracted.location) found.push('location');

                showNotice(el.extractionNotice,
                    'Details read from the page (' + found.join(', ') + '). The page was fetched by ' +
                    (result.route === 'direct' ? 'your browser.' : 'an external text service, which received the link.') +
                    ' Check every field before continuing.',
                    extracted.missing.length ? 'warning' : 'success');

                (extracted.missing.length ? el.form : el.title).focus();
            }).catch(function () {
                showNotice(el.extractionNotice,
                    'The page could not be read. Copy the event text and paste it here instead.',
                    'warning');
            }).then(function () {
                button.disabled = false;
                el.btnText.textContent = originalLabel;
            });
        }

        function runExtraction() {
            var text = el.rawText.value;
            // Never leave a message from an earlier attempt on screen.
            hide(el.extractionNotice);
            hide(el.extractionHint);
            clearFieldMarks();

            if (!text.trim()) {
                showNotice(el.extractionNotice, 'Paste some event text or a link first, then choose Extract Event Details.', 'error');
                el.rawText.focus();
                return;
            }

            // A link on its own is read from the web instead of being given up on.
            if (UrlFetch.looksLikeUrl(text) && Extractor.urlOnlyFeedback(text)) {
                runUrlExtraction(UrlFetch.normalizeUrl(text));
                return;
            }

            var urlOnly = Extractor.urlOnlyFeedback(text);
            var extracted = Extractor.extract(text);

            if (!extracted || !extracted.title) {
                showNotice(el.extractionNotice,
                    'No event title could be found in that text. Add the event name, or a line starting with "Event:", and try again.',
                    'error');
                el.rawText.focus();
                return;
            }

            fillForm(extracted);
            hide(el.extractionNotice);

            if (urlOnly) {
                // Step 10: explain what could not be done instead of pretending.
                showNotice(el.extractionNotice, urlOnly.message, 'warning');
            } else if (extracted.urls.length) {
                showNotice(el.extractionNotice,
                    'Details extracted. A link was shared as well, but the details below come from your ' +
                    'text - check them before continuing.',
                    'info');
            } else {
                showNotice(el.extractionNotice,
                    'Details extracted. Check every field below - you can edit anything before continuing.',
                    'success');
            }

            showReview();
            showHint(extracted);
            (extracted.missing.length ? el.form : el.title).focus();
        }

        function fillForm(extracted) {
            el.title.value = extracted.title;
            el.date.value = extracted.date;
            el.start.value = extracted.startTime;
            el.end.value = extracted.endTime;
            el.location.value = extracted.location;
            el.description.value = extracted.description;
            clearFieldMarks();
        }

        /** Tell the user which details could not be identified (Step 4/5). */
        function showHint(extracted) {
            var missing = extracted.missing || [];

            if (!missing.length) {
                if (extracted.sources && extracted.sources.relative && extracted.sources.date) {
                    showNotice(el.extractionHint,
                        'The date was worked out from "' + extracted.sources.date + '". Check that it is the day you expect.',
                        'info');
                    return;
                }
                hide(el.extractionHint);
                return;
            }

            var names = missing.map(function (key) { return MISSING_TEXT[key] || key; });
            var listed = names.length === 1
                ? names[0]
                : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
            var single = names.length === 1;

            showNotice(el.extractionHint,
                'CalSnap could not identify the ' + listed + ' from your text, so ' +
                (single ? 'that field is' : 'those fields are') + ' empty. Please fill ' +
                (single ? 'it' : 'them') + ' in below.',
                'warning');
        }

        /* ------------------------------------------------------------------ *
         * Review and validation (Step 5)
         * ------------------------------------------------------------------ */

        function collectEvent() {
            return {
                title: el.title.value,
                date: el.date.value,
                startTime: el.start.value,
                endTime: el.end.value,
                location: el.location.value,
                description: el.description.value,
                reminder: el.reminder.value
            };
        }

        /** Validate the form and explain exactly what has to be corrected. */
        function getValidatedEvent() {
            var result = Validation.validate(collectEvent());
            clearFieldMarks();

            if (!result.ok) {
                markFields(result.errors);
                showStatus(result.errors.map(function (error) { return error.message; }).join(' '), 'error');
                var first = fieldFor(result.errors[0] && result.errors[0].field);
                if (first) first.focus();
                return null;
            }

            return result;
        }

        function fieldFor(name) {
            return {
                title: el.title,
                date: el.date,
                startTime: el.start,
                endTime: el.end,
                location: el.location,
                description: el.description,
                reminder: el.reminder
            }[name] || null;
        }

        function markFields(errors) {
            errors.forEach(function (error) {
                var field = fieldFor(error.field);
                if (field) field.setAttribute('aria-invalid', 'true');
            });
        }

        function clearFieldMarks() {
            TEXT_FIELDS.forEach(function (key) {
                var field = fieldFor(key);
                if (field) field.removeAttribute('aria-invalid');
            });
            hide(el.status);
        }

        /* ------------------------------------------------------------------ *
         * Step 7: Google Calendar
         * ------------------------------------------------------------------ */

        function handleGoogle() {
            var result = getValidatedEvent();
            if (!result) return;

            var url = CalendarCore.generateGoogleUrl(result.event);
            if (!url) {
                showStatus('The event details are not complete enough to build a Google Calendar link.', 'error');
                return;
            }

            var opened = window.open(url, '_blank');
            if (opened) {
                // Prevent the new page from accessing window.opener.
                opened.opener = null;
            } else {
                // Popup blocked: show a fallback link.
                el.status.textContent = '';
                el.status.className = 'status error';

                var msg = document.createTextNode('Your browser blocked the new tab. Open this link to continue: ');
                var a = document.createElement('a');
                a.href = url;
                a.textContent = 'Google Calendar';
                a.target = '_blank';
                a.rel = 'noopener noreferrer';

                el.status.appendChild(msg);
                el.status.appendChild(a);
                return;
            }

            // Deliberately not "event added": Google Calendar has only opened.
            var notes = ['A prefilled Google Calendar page opened in a new tab. Review it there and press Save - nothing is added to your calendar until you do.'];
            if (result.event.reminder !== 'none') notes.push(CalendarCore.GOOGLE_REMINDER_NOTICE);
            result.warnings.forEach(function (warning) { notes.push(warning.message); });
            showStatus(notes.join(' '), 'info');
        }

        /* ------------------------------------------------------------------ *
         * Step 8: .ics download
         * ------------------------------------------------------------------ */

        function handleDownload() {
            var result = getValidatedEvent();
            if (!result) return;

            var icsText = CalendarCore.generateICS(result.event);
            if (!icsText) {
                showStatus('The event details are not complete enough to build a calendar file.', 'error');
                return;
            }

            var fileName = CalendarCore.suggestFileName(result.event);
            var endTime = result.event.endTime || CalendarCore.endTimeFor(result.event);
            var notes = [
                '"' + fileName + '" was downloaded. Open it to import the event into your calendar application - CalSnap cannot add it for you.',
                'Event time: ' + Validation.describe(result.event) + ' to ' + endTime +
                (result.event.endTime ? '.' : ' (one hour).')
            ];

            if (result.event.reminder !== 'none') notes.push(CalendarCore.ICS_REMINDER_NOTICE);
            result.warnings.forEach(function (warning) { notes.push(warning.message); });

            downloadFile(icsText, fileName);
            showStatus(notes.join(' '), 'success');
        }

        function downloadFile(content, fileName) {
            var blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            // Revoked late so a slow mobile browser still starts the download.
            window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        }

        /* ------------------------------------------------------------------ *
         * Step 9: sharing through the device interface
         * ------------------------------------------------------------------ */

        function handleShare() {
            var result = getValidatedEvent();
            if (!result) return;

            var shareText = CalendarCore.buildShareText(result.event);

            if (navigator.share) {
                navigator.share({ title: result.event.title, text: shareText }).then(function () {
                    showStatus('The device share sheet was used. What happens next depends on the application you picked.', 'info');
                }).catch(function (error) {
                    if (error && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
                        showStatus('Sharing was cancelled.', 'info');
                        return;
                    }
                    copyFallback(shareText);
                });
                return;
            }

            copyFallback(shareText);
        }

        function copyFallback(shareText) {
            if (!navigator.clipboard || !navigator.clipboard.writeText) {
                showStatus('This browser cannot share or copy automatically. The event details are: ' + shareText, 'info');
                return;
            }
            navigator.clipboard.writeText(shareText).then(function () {
                showStatus('This browser has no share sheet, so the event details were copied to the clipboard instead. Paste them wherever you need.', 'info');
            }).catch(function () {
                showStatus('This browser cannot share or copy automatically. The event details are: ' + shareText, 'info');
            });
        }

        /* ------------------------------------------------------------------ *
         * Small view helpers
         * ------------------------------------------------------------------ */

        function showReview() {
            hide(el.inputSection);
            el.inputSection.classList.remove('fade-in');
            el.reviewSection.classList.remove('hidden');
            el.reviewSection.classList.add('fade-in');
            if (el.reviewSection.scrollIntoView) {
                el.reviewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }

        function showInput() {
            hide(el.reviewSection);
            el.reviewSection.classList.remove('fade-in');
            el.inputSection.classList.remove('hidden');
            el.inputSection.classList.add('fade-in');
            el.rawText.focus();
        }

        function showNotice(element, message, kind) {
            element.textContent = message;
            element.className = 'notice ' + (kind || 'info');
        }

        function showStatus(message, kind) {
            el.status.textContent = message;
            el.status.className = 'status ' + (kind || 'info');
        }

        function hide(element) {
            element.classList.add('hidden');
        }
    });
})();
