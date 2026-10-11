/**
 * Paragraph extraction -> Google Calendar event, end to end.
 *
 * Event text copied from a website, an email or a messaging app almost always
 * arrives as one long paragraph with the details buried inside sentences, rather
 * than as a tidy list of "Date:" and "Location:" lines. These tests use that shape
 * and assert the WHOLE decoded event rather than individual substrings:
 *
 *   paragraph -> Extractor.extract -> Validation.validate -> generateGoogleUrl
 *             -> tests/google-url-reader.js -> decoded event
 *
 * What is checked about the title: it must be non-empty and must contain none of
 * the date or time text. A name plus a small amount of surrounding wording is
 * acceptable ("Join our webinar Introduction to Machine Learning") because the user
 * reviews and edits it; a name containing date debris ("Summer Garden Party, 12 26")
 * is a defect, so that is asserted against directly.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Extractor, Validation, CalendarCore } = require('./load-globals.js');
const { readGoogleUrl, durationMinutes } = require('./google-url-reader.js');
const ics = require('./ics-reader.js');

const NOW = new Date(2026, 0, 2, 10, 0, 0); // Friday 2 January 2026, 10:00 local

/** The paragraph from the reported failure, as pasted. */
const SUMMIT_PARAGRAPH =
    'The Event name as NextGen AI & Tech Summit 2026 will take place on Thursday, ' +
    'November 12, 2026, from 09:00 AM to 05:00 PM IST (with registration opening ' +
    'early at 08:15 AM). This premier industry event, hosted by the Nexus Innovations ' +
    'Group, will be held at The Grand Ballroom inside the ITC Grand Chola, located at ' +
    'No. 63, Anna Salai, Guindy, Chennai, Tamil Nadu, 600032. Attendees can look ' +
    'forward to a full day of keynote speeches, interactive panel discussions, and ' +
    'structured networking sessions designed for technology leaders and innovators.';

/** The whole pipeline, exactly as js/ui.js drives it. */
function toCalendarEvent(text, options = {}) {
    const extracted = Extractor.extract(text, { now: options.now || NOW });
    assert.ok(extracted, 'extraction must return a result for: ' + text.slice(0, 40));

    const reviewed = Object.assign({}, extracted, options.edits || {}, {
        reminder: options.reminder || 'none'
    });
    const validated = Validation.validate(reviewed, { now: options.now || NOW });

    return { extracted, validated };
}

/** paragraph -> decoded Google Calendar event (or the blocking errors). */
function googleEventFor(text, options) {
    const { validated } = toCalendarEvent(text, options);
    if (!validated.ok) return { blocked: validated.errors, event: null };
    return { blocked: null, event: readGoogleUrl(CalendarCore.generateGoogleUrl(validated.event)) };
}

/**
 * A title must not carry the date or time it was extracted from. This is the check
 * that would have caught the "no event title found" and "Summer Garden Party, 12 26"
 * defects, without pinning the test to one acceptable wording.
 */
function assertTitleIsClean(title, text, details) {
    assert.ok(title && title.length >= 2, 'a title must be found in: ' + text.slice(0, 60));

    const scrap = [details.date, details.startTime, details.endTime, 'AM', 'PM', 'IST']
        .filter(Boolean);
    for (const value of scrap) {
        assert.ok(!title.includes(value), 'the title must not contain "' + value + '": ' + title);
    }

    assert.doesNotMatch(title, /\d{1,4}\s+\d{1,4}\s*$/, 'no trailing date numbers: ' + title);
    assert.doesNotMatch(title, /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/, 'no date in the title: ' + title);
    assert.doesNotMatch(title, /\b(?:noon|midnight)\b/i, 'no time word in the title: ' + title);
    assert.doesNotMatch(title, /\bon\s*$/i, 'no dangling "on": ' + title);
}

/* -------------------------------------------------------------------------- *
 * The reported case
 * -------------------------------------------------------------------------- */

test('paragraph: the summit paragraph fills every field correctly', () => {
    const { extracted, validated } = toCalendarEvent(SUMMIT_PARAGRAPH);

    assert.equal(extracted.title, 'The Event name as NextGen AI & Tech Summit 2026');
    assert.equal(extracted.date, '2026-11-12');
    assert.equal(extracted.startTime, '09:00');
    assert.equal(extracted.endTime, '17:00'); // 05:00 PM
    assert.equal(extracted.location, 'The Grand Ballroom');
    assert.deepEqual(extracted.missing, [], 'the form must not ask for anything');
    assert.equal(validated.ok, true, 'validation must pass so the calendar buttons work');
    assert.deepEqual(validated.errors, []);
});

test('paragraph: the Google Calendar event decodes back to exactly those details', () => {
    const { event, blocked } = googleEventFor(SUMMIT_PARAGRAPH);
    assert.equal(blocked, null, 'nothing should be missing');

    assert.deepEqual(event.summary(), {
        title: 'The Event name as NextGen AI & Tech Summit 2026',
        date: '2026-11-12',
        startTime: '09:00',
        endTime: '17:00',
        location: 'The Grand Ballroom'
    });
    assert.equal(event.action, 'TEMPLATE');
    assert.equal(event.endpoint, 'https://calendar.google.com/calendar/render');
    assert.equal(durationMinutes(event), 8 * 60, '09:00 to 17:00 is eight hours');
});

test('paragraph: the description carries the full text the user pasted', () => {
    const { event } = googleEventFor(SUMMIT_PARAGRAPH);

    // Google Calendar is given the whole paragraph, so nothing the user read is lost.
    assert.match(event.description, /NextGen AI & Tech Summit 2026/);
    assert.match(event.description, /Nexus Innovations Group/);
    assert.match(event.description, /keynote speeches, interactive panel discussions/);
    assert.ok(event.description.length > 300, 'the description is not truncated');
});

test('paragraph: the Google times decode back to the times written in the paragraph', () => {
    const { event } = googleEventFor(SUMMIT_PARAGRAPH);

    // "from 09:00 AM to 05:00 PM" in the text must arrive as 09:00-17:00 in the
    // prefilled page. A missing Z on the UTC stamp made Google show 03:30-11:30 for a
    // user on UTC+05:30, so this is asserted through the decoded event, not the raw URL.
    assert.equal(event.startTime, '09:00');
    assert.equal(event.endTime, '17:00');

    const raw = new URL(CalendarCore.generateGoogleUrl(
        Validation.validate(Extractor.extract(SUMMIT_PARAGRAPH, { now: NOW }), { now: NOW }).event
    )).searchParams.get('dates');
    assert.match(raw, /Z\//, 'both stamps must carry the UTC marker');
});

test('paragraph: the same details survive into the .ics file', () => {
    const { validated } = toCalendarEvent(SUMMIT_PARAGRAPH);
    const props = ics.properties(CalendarCore.generateICS(validated.event, { now: NOW }));

    assert.equal(ics.unescapeText(props.SUMMARY), 'The Event name as NextGen AI & Tech Summit 2026');
    assert.equal(ics.unescapeText(props.LOCATION), 'The Grand Ballroom');

    const start = ics.stampToLocalDate(props.DTSTART);
    const end = ics.stampToLocalDate(props.DTEND);
    assert.deepEqual(
        [start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()],
        [11, 12, 9, 0],
        'DTSTART must be 12 November 2026 at 09:00 local'
    );
    assert.deepEqual(
        [end.getMonth() + 1, end.getDate(), end.getHours(), end.getMinutes()],
        [11, 12, 17, 0],
        'DTEND must be 12 November 2026 at 17:00 local'
    );
});

/* -------------------------------------------------------------------------- *
 * Other paragraph shapes a real user will paste
 * -------------------------------------------------------------------------- */

const PARAGRAPHS = [
    {
        name: 'ticket page in 24-hour time',
        text: 'Neon Nights: A Synthwave Concert is happening on Saturday, 20 June 2026, from 20:30 to 23:45 at the Skyline Rooftop Lounge, 14 Marine Drive. Doors open at 19:30.',
        expect: { date: '2026-06-20', startTime: '20:30', endTime: '23:45', location: 'Skyline Rooftop Lounge' }
    },
    {
        name: 'webinar with a registration aside',
        text: 'Join our webinar Introduction to Machine Learning on 2026-09-03 at 15:00 (please register 10 minutes early). The session runs for ninety minutes.',
        expect: { title: 'Introduction to Machine Learning', date: '2026-09-03', startTime: '15:00' }
    },
    {
        name: 'day-first date with a spelled-out range',
        text: 'The Riverside Charity Run takes place on 4 October 2026. The race starts at 08:00 AM and finishes at 11:30 AM at Riverside Park, Gate 3.',
        expect: {
            title: 'The Riverside Charity Run', date: '2026-10-04',
            startTime: '08:00', endTime: '11:30', location: 'Riverside Park'
        }
    },
    {
        name: 'weekday plus month/day and a venue clause',
        text: 'The Annual Shareholders Meeting, hosted by the Board of Directors, will be held on Tuesday, March 3, 2026, starting at 10:00 AM. The venue is the Head Office Auditorium.',
        expect: { title: 'The Annual Shareholders Meeting', date: '2026-03-03', startTime: '10:00' }
    },
    {
        name: 'relative date in a chat message',
        text: 'Team retrospective tomorrow at 4:30 PM in Meeting Room 2. Bring your sprint notes.',
        expect: { date: '2026-01-03', startTime: '16:30', location: 'Meeting Room 2' }
    },
    {
        name: '12-hour range sharing one meridiem',
        text: 'Open house at the Design Studio on 2026-11-05 from 2 to 4 PM. Come and meet the team.',
        expect: { title: 'Open house at the Design Studio', date: '2026-11-05', startTime: '14:00', endTime: '16:00' }
    },
    {
        name: 'noon to late evening',
        text: 'Summer Garden Party on Sunday, 12 July 2026, from noon until midnight at the Botanical Gardens.',
        expect: { title: 'Summer Garden Party', date: '2026-07-12', startTime: '12:00', endTime: '00:00' }
    }
];

for (const sample of PARAGRAPHS) {
    test('paragraph: ' + sample.name + ' -> correct Google Calendar event', () => {
        const { extracted, validated } = toCalendarEvent(sample.text);

        assertTitleIsClean(extracted.title, sample.text, extracted);
        if (sample.expect.title) {
            assert.ok(
                extracted.title.includes(sample.expect.title),
                'the title should include "' + sample.expect.title + '", got "' + extracted.title + '"'
            );
        }

        assert.equal(extracted.date, sample.expect.date, 'date');
        assert.equal(extracted.startTime, sample.expect.startTime, 'start time');
        assert.equal(validated.ok, true, 'the event must validate: ' + JSON.stringify(validated.errors));

        if (sample.expect.endTime !== undefined) {
            assert.equal(extracted.endTime, sample.expect.endTime, 'end time');
        }
        if (sample.expect.location !== undefined) {
            assert.ok(
                extracted.location.toLowerCase().includes(sample.expect.location.toLowerCase()),
                'location should include "' + sample.expect.location + '", got "' + extracted.location + '"'
            );
        }

        // ...and the decoded Google Calendar event agrees with the extraction.
        const { event } = googleEventFor(sample.text);
        assert.deepEqual(event.summary(), {
            title: extracted.title,
            date: extracted.date,
            startTime: extracted.startTime,
            endTime: extracted.endTime || CalendarCore.endTimeFor(extracted),
            location: extracted.location
        }, 'the decoded event must match the reviewed details field by field');

        assert.ok(durationMinutes(event) > 0, 'the decoded end must be after the decoded start');
    });
}

test('paragraph: every sample also produces a valid .ics document', () => {
    for (const sample of PARAGRAPHS) {
        const { extracted, validated } = toCalendarEvent(sample.text);
        const text = CalendarCore.generateICS(validated.event, { now: NOW });
        const props = ics.properties(text);

        assert.equal(ics.unescapeText(props.SUMMARY), extracted.title, sample.name);
        assert.ok(props.UID, sample.name);
        assert.equal(props.DTSTART, ics.localToStamp(sample.expect.date, sample.expect.startTime), sample.name);
        assert.deepEqual(ics.overlongLines(text), [], 'no line may exceed 75 octets: ' + sample.name);
    }
});

/* -------------------------------------------------------------------------- *
 * The guarantees that make the decoded event trustworthy
 * -------------------------------------------------------------------------- */

test('paragraph: a user correction is what reaches Google Calendar, not the guess', () => {
    const { event } = googleEventFor(SUMMIT_PARAGRAPH, {
        edits: { title: 'NextGen AI Summit (my notes)', date: '2026-11-13', startTime: '10:00', endTime: '18:00' }
    });

    assert.deepEqual(event.summary(), {
        title: 'NextGen AI Summit (my notes)',
        date: '2026-11-13',
        startTime: '10:00',
        endTime: '18:00',
        location: 'The Grand Ballroom'
    });
});

test('paragraph: a missing end time becomes one hour and is declared in the .ics', () => {
    const text = 'Gallery opening on 2026-08-14 at 18:00 at the Modern Art Museum.';
    const { extracted, validated } = toCalendarEvent(text);
    assert.equal(extracted.endTime, '', 'no end time is invented at extraction');
    assert.equal(validated.ok, true);
    assert.match(validated.warnings[0].message, /one hour long/i);

    const { event } = googleEventFor(text);
    assert.equal(durationMinutes(event), 60, 'the Google event is one hour, not zero length');

    const props = ics.properties(CalendarCore.generateICS(validated.event, { now: NOW }));
    assert.match(ics.unescapeText(props['X-CALSNAP-NOTE']), /No end time was supplied/);
});

test('paragraph: a paragraph with no date is refused instead of guessed', () => {
    const text = 'Our quarterly team offsite is being planned. Details to follow.';
    const { extracted, validated } = toCalendarEvent(text);
    assert.equal(extracted.date, '');
    assert.equal(validated.ok, false, 'the calendar buttons must stay blocked');
    assert.ok(validated.errors.some((error) => error.field === 'date'));

    const { event, blocked } = googleEventFor(text);
    assert.equal(event, null, 'no Google Calendar link may be produced');
    assert.ok(blocked.length > 0);
});

test('paragraph: links in a paragraph are kept in the description and never become the location', () => {
    const text = 'Winter Fundraiser Gala on Friday, 18 December 2026, 7:00 PM at The Old Mill. ' +
        'Tickets: https://example.com/gala-tickets';
    const { extracted, validated } = toCalendarEvent(text);

    assert.equal(extracted.location, 'The Old Mill');
    assert.equal(validated.ok, true);

    const { event } = googleEventFor(text);
    assert.match(event.description, /https:\/\/example\.com\/gala-tickets/);
    assert.doesNotMatch(event.location, /http/i);
});

test('paragraph: an event running past midnight keeps a sensible end', () => {
    const text = 'New Year Countdown Party on Thursday, 31 December 2026, from 9:00 PM until midnight at the Rooftop Bar.';
    const { extracted, validated } = toCalendarEvent(text);

    assert.equal(extracted.date, '2026-12-31');
    assert.equal(extracted.startTime, '21:00');
    assert.equal(extracted.endTime, '00:00', 'midnight is written as 00:00');
    assert.equal(validated.ok, true, 'running to midnight must not be called a backwards range');

    const { event } = googleEventFor(text);
    assert.equal(event.endDate, '2027-01-01', 'the end instant is the next day');
    assert.equal(durationMinutes(event), 3 * 60, '21:00 to midnight is three hours');
});

test('paragraph: the decoded event never claims the event was saved', () => {
    const { event } = googleEventFor(SUMMIT_PARAGRAPH);
    const everything = [event.title, event.description, event.location].join(' ');
    assert.doesNotMatch(everything, /\b(?:saved|added to your calendar|scheduled|created)\b/i);
    assert.match(CalendarCore.GOOGLE_REMINDER_NOTICE, /does not save the event/i);
});

test('paragraph: extraction is stable across repeated runs', () => {
    const first = toCalendarEvent(SUMMIT_PARAGRAPH).extracted;
    const second = toCalendarEvent(SUMMIT_PARAGRAPH).extracted;
    assert.deepEqual(first, second, 'the same input must always give the same event');
});
