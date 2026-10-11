/**
 * End-to-end workflow test - Step 13 items 1-13 in one pass.
 *
 * This drives the real modules in the order the application uses them:
 *
 *   shared/pasted text -> extract -> validate -> Google URL -> .ics -> read back
 *
 * If this file passes, the main workflow (Share -> Extract -> Review -> Add to
 * Calendar -> Reminder) works for the described input.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Extractor, Validation, CalendarCore } = require('./load-globals.js');
const ics = require('./ics-reader.js');

const NOW = new Date(2026, 0, 2, 10, 0, 0); // Friday 2 January 2026, 10:00 local

/** Text of the kind a user actually shares from an event page. */
const SHARED_TEXT = [
    'Annual Design Summit 2026',
    'Saturday, 14 March 2026',
    'Time: 9:30 AM - 4:00 PM',
    'Location: Riverside Convention Centre, Hall B',
    '',
    'Join 300 designers for a day of talks, workshops and portfolio reviews.',
    'Tickets and the full agenda: https://example.com/summit-2026'
].join('\n');

/** The whole pipeline, exactly as js/ui.js calls it. */
function runPipeline(text, options = {}) {
    const extracted = Extractor.extract(text, { now: options.now || NOW });
    assert.ok(extracted, 'extraction must produce a result');

    const reviewed = Object.assign({}, extracted, options.edits || {}, {
        reminder: options.reminder || 'none'
    });
    const validated = Validation.validate(reviewed, { now: options.now || NOW });
    return { extracted, reviewed, validated };
}

test('end to end: shared text becomes a complete, validated event', () => {
    const { extracted, validated } = runPipeline(SHARED_TEXT);

    // 1-5: title, date, start, end, location and description are all found.
    assert.equal(extracted.title, 'Annual Design Summit 2026');
    assert.equal(extracted.date, '2026-03-14');
    assert.equal(extracted.startTime, '09:30');
    assert.equal(extracted.endTime, '16:00');
    assert.equal(extracted.location, 'Riverside Convention Centre, Hall B');
    assert.match(extracted.description, /Join 300 designers/);
    assert.deepEqual(extracted.missing, [], 'nothing is missing, so the user is asked nothing');

    // 7: the details pass validation, ready for a calendar.
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.errors, []);
});

test('end to end: the reviewed event produces a correct Google Calendar link', () => {
    const { validated } = runPipeline(SHARED_TEXT);
    const params = new URL(CalendarCore.generateGoogleUrl(validated.event)).searchParams;

    assert.equal(params.get('text'), 'Annual Design Summit 2026');
    assert.equal(params.get('location'), 'Riverside Convention Centre, Hall B');
    assert.match(params.get('details'), /Join 300 designers/);

    const [start, end] = params.get('dates').split('/');
    // UTC with the Z, which is what makes Google show the reviewed local times.
    assert.equal(start, ics.localToStamp('2026-03-14', '09:30'));
    assert.equal(end, ics.localToStamp('2026-03-14', '16:00'));
});

test('end to end: the reviewed event produces a correct .ics file', () => {
    const { validated } = runPipeline(SHARED_TEXT);
    const text = CalendarCore.generateICS(validated.event, { now: NOW });
    const props = ics.properties(text);

    assert.ok(text.startsWith('BEGIN:VCALENDAR'));
    assert.equal(ics.unescapeText(props.SUMMARY), 'Annual Design Summit 2026');
    assert.equal(ics.unescapeText(props.LOCATION), 'Riverside Convention Centre, Hall B');
    assert.match(ics.unescapeText(props.DESCRIPTION), /Join 300 designers/);
    assert.match(ics.unescapeText(props.DESCRIPTION), /https:\/\/example\.com\/summit-2026/);

    const start = ics.stampToLocalDate(props.DTSTART);
    assert.deepEqual([start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()], [3, 14, 9, 30]);
});

test('end to end: the selected reminder reaches the .ics file only', () => {
    for (const [reminder, trigger] of [['15', '-PT15M'], ['60', '-PT60M'], ['1440', '-PT1440M']]) {
        const { validated } = runPipeline(SHARED_TEXT, { reminder });
        const text = CalendarCore.generateICS(validated.event, { now: NOW });
        assert.deepEqual(ics.allValues(text, 'TRIGGER'), [trigger], 'reminder ' + reminder);
    }

    const none = runPipeline(SHARED_TEXT, { reminder: 'none' });
    assert.equal(CalendarCore.generateICS(none.validated.event, { now: NOW }).includes('VALARM'), false);
});

test('end to end: a user correction flows into both calendar outputs', () => {
    // The extractor gets the date wrong on purpose; the user fixes it (Step 5).
    const { extracted, validated } = runPipeline('Team sync on 5/1/2026 at 10:00', {
        edits: { date: '2026-05-01', endTime: '11:30' }
    });

    assert.equal(extracted.date, '2026-05-01', 'month/day is the convention for an ambiguous numeric date');
    assert.equal(validated.ok, true);

    const url = CalendarCore.generateGoogleUrl(validated.event);
    assert.match(new URL(url).searchParams.get('dates'), /^20260501T/);

    const text = CalendarCore.generateICS(validated.event, { now: NOW });
    const props = ics.properties(text);
    assert.equal(props.DTSTART, ics.localToStamp('2026-05-01', '10:00'));
    assert.equal(props.DTEND, ics.localToStamp('2026-05-01', '11:30'));
});

test('end to end: incomplete input is completed by the user, never invented', () => {
    const { extracted, validated } = runPipeline('Dentist appointment, bring the insurance card');
    assert.deepEqual(extracted.missing, ['date', 'startTime'], 'no date or time may be guessed');
    assert.equal(validated.ok, false, 'the calendar actions must be blocked');

    // The user supplies what was missing.
    const finished = Validation.validate(Object.assign({}, extracted, {
        date: '2026-02-04',
        startTime: '08:15',
        reminder: '1440'
    }), { now: NOW });

    assert.equal(finished.ok, true);
    const text = CalendarCore.generateICS(finished.event, { now: NOW });
    assert.deepEqual(ics.allValues(text, 'TRIGGER'), ['-PT1440M']);
    assert.match(ics.unescapeText(ics.properties(text).SUMMARY), /Dentist appointment/);
});

test('end to end: a vague relative phrase is resolved and flagged for checking', () => {
    // "next month" is a real hint, so it is used - but the interface marks it as
    // something the user should confirm rather than a certain date.
    const { extracted } = runPipeline('Dentist appointment sometime next month');
    assert.equal(extracted.date, '2026-02-02');
    assert.equal(extracted.sources.relative, true);
    assert.deepEqual(extracted.missing, ['startTime']);
});

test('end to end: a link-only share is reported, never faked', () => {
    const url = 'https://example.com/events/spring-product-launch';
    const extracted = Extractor.extract(url, { now: NOW });

    // A slug title may be offered as a starting point...
    assert.equal(extracted.title, 'spring product launch');
    // ...but no date or time is invented, and the user is told why.
    assert.equal(extracted.date, '');
    assert.equal(extracted.startTime, '');
    assert.deepEqual(extracted.missing, ['date', 'startTime']);

    const feedback = Extractor.urlOnlyFeedback(url);
    assert.match(feedback.message, /cannot read a webpage/i);

    const validated = Validation.validate(extracted, { now: NOW });
    assert.equal(validated.ok, false);
});

test('end to end: nothing in the pipeline claims an event was already saved', () => {
    const { validated } = runPipeline(SHARED_TEXT, { reminder: '15' });
    const messages = [
        CalendarCore.GOOGLE_REMINDER_NOTICE,
        CalendarCore.ICS_REMINDER_NOTICE,
        CalendarCore.buildShareText(validated.event)
    ];

    for (const message of messages) {
        assert.doesNotMatch(message, /\b(?:has been|was|is) (?:saved|added|created|scheduled)\b/i,
            'no message may claim the event exists in a calendar: ' + message);
        assert.doesNotMatch(message, /reminder (?:is|has been) set\b/i,
            'no message may promise a notification: ' + message);
    }
});

test('end to end: every supported event phrasing survives the pipeline', () => {
    const samples = [
        { text: 'Standup tomorrow at 9:15 AM', date: '2026-01-03', start: '09:15' },
        { text: 'Yoga Monday at 6 PM', date: '2026-01-05', start: '18:00' },
        { text: 'Webinar 2026-04-08 15:00', date: '2026-04-08', start: '15:00' },
        { text: 'Wedding on 12 September 2026 at 14:00', date: '2026-09-12', start: '14:00' },
        { text: 'Sprint review in 2 weeks at 11:00', date: '2026-01-16', start: '11:00' }
    ];

    for (const sample of samples) {
        const { extracted, validated } = runPipeline(sample.text);
        assert.equal(extracted.date, sample.date, sample.text);
        assert.equal(extracted.startTime, sample.start, sample.text);
        assert.equal(validated.ok, true, sample.text);

        // Both outputs must be buildable for every phrasing.
        assert.ok(CalendarCore.generateGoogleUrl(validated.event).length > 40, sample.text);
        assert.ok(CalendarCore.generateICS(validated.event, { now: NOW }).includes('BEGIN:VEVENT'), sample.text);
    }
});

test('end to end: all four reminder options are selectable and behave', () => {
    const options = ['none', '15', '60', '1440'];
    for (const reminder of options) {
        const { validated } = runPipeline(SHARED_TEXT, { reminder });
        assert.equal(validated.ok, true, 'reminder ' + reminder);
        assert.equal(validated.event.reminder, reminder);
        const text = CalendarCore.generateICS(validated.event, { now: NOW });
        assert.equal(text.includes('VALARM'), reminder !== 'none', 'reminder ' + reminder);
    }
});
