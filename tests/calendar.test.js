/**
 * CalSnap calendar tests - Steps 6, 7, 8 and Step 13 items 8-10.
 *
 * These verify both directions: the values written into the Google Calendar URL
 * and the .ics file, and what a calendar application would read back out of them.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CalendarCore, Validation } = require('./load-globals.js');
const ics = require('./ics-reader.js');

const FIXED_NOW = new Date(2026, 3, 20, 8, 15, 0); // 20 April 2026, 08:15 local

const baseEvent = {
    title: 'Design Review',
    date: '2026-05-01',
    startTime: '15:30',
    endTime: '17:00',
    location: 'Studio 2',
    description: 'Bring wireframes',
    reminder: 'none'
};

function withEvent(overrides = {}) {
    return Object.assign({}, baseEvent, overrides);
}

/* -------------------------------------------------------------------------- *
 * Google Calendar URL (Step 7)
 * -------------------------------------------------------------------------- */

test('google: URL contains title, UTC start/end, location and details', () => {
    const url = CalendarCore.generateGoogleUrl(baseEvent);
    const params = new URL(url).searchParams;

    assert.equal(new URL(url).origin + new URL(url).pathname, 'https://calendar.google.com/calendar/render');
    assert.equal(params.get('action'), 'TEMPLATE');
    assert.equal(params.get('text'), 'Design Review');
    assert.equal(params.get('location'), 'Studio 2');
    assert.equal(params.get('details'), 'Bring wireframes');

    // Google expects the UTC form without the trailing Z, plus the device timezone.
    const [start, end] = params.get('dates').split('/');
    assert.equal(start, ics.localToStamp('2026-05-01', '15:30').replace(/Z$/, ''));
    assert.equal(end, ics.localToStamp('2026-05-01', '17:00').replace(/Z$/, ''));
    assert.match(params.get('dates'), /^\d{8}T\d{6}\/\d{8}T\d{6}$/);
    assert.ok(params.get('ctz'), 'the device timezone is sent so Google shows the intended local time');
});

test('google: date and time survive the round trip in this timezone', () => {
    const params = new URL(CalendarCore.generateGoogleUrl(baseEvent)).searchParams;
    const [start] = params.get('dates').split('/');
    const iso = start.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
        '$1-$2-$3T$4:$5:$6Z'
    );
    const local = new Date(iso);
    assert.equal(local.getFullYear(), 2026);
    assert.equal(local.getMonth(), 4); // May
    assert.equal(local.getDate(), 1);
    assert.equal(local.getHours(), 15);
    assert.equal(local.getMinutes(), 30);
});

test('google: a missing end time becomes start + 1 hour, not a zero-length event', () => {
    const params = new URL(CalendarCore.generateGoogleUrl(withEvent({ endTime: '' }))).searchParams;
    const [start, end] = params.get('dates').split('/');
    assert.equal(start, ics.localToStamp('2026-05-01', '15:30').replace(/Z$/, ''));
    assert.equal(end, ics.localToStamp('2026-05-01', '16:30').replace(/Z$/, ''));
});

test('google: no URL is produced for an unusable event', () => {
    assert.equal(CalendarCore.generateGoogleUrl({ title: 'x', date: '', startTime: '' }), '');
});

test('google: optional fields are omitted rather than sent empty', () => {
    const params = new URL(CalendarCore.generateGoogleUrl(withEvent({ location: '', description: '' }))).searchParams;
    assert.equal(params.has('location'), false);
    assert.equal(params.has('details'), false);
});

/* -------------------------------------------------------------------------- *
 * .ics generation (Step 8)
 * -------------------------------------------------------------------------- */

test('ics: valid document skeleton with one VEVENT', () => {
    const text = CalendarCore.generateICS(baseEvent, { now: FIXED_NOW });

    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.equal((text.match(/END:VEVENT/g) || []).length, 1);
    assert.equal(text.includes('\n\n'), false, 'no blank lines');

    const props = ics.properties(text);
    assert.equal(props.VERSION, '2.0');
    assert.match(props.PRODID, /CalSnap/);
    assert.equal(props.CALSCALE, 'GREGORIAN');
});

test('ics: every event carries a UID, and UIDs differ between downloads', () => {
    const first = ics.properties(CalendarCore.generateICS(baseEvent, { now: FIXED_NOW }));
    const second = ics.properties(CalendarCore.generateICS(baseEvent, { now: FIXED_NOW }));
    assert.ok(first.UID && first.UID.length > 5);
    assert.match(first.UID, /@calsnap$/);
    assert.notEqual(first.UID, second.UID, 'two downloads of the same event must not share a UID');
});

test('ics: DTSTART/DTEND round-trip to the reviewed local time', () => {
    const props = ics.properties(CalendarCore.generateICS(baseEvent, { now: FIXED_NOW }));
    // DTSTAMP is UTC, so it is compared through the same conversion the file uses.
    assert.equal(props.DTSTAMP, ics.localToStamp('2026-04-20', '08:15'),
        'DTSTAMP must come from the supplied clock');

    const start = ics.stampToLocalDate(props.DTSTART);
    const end = ics.stampToLocalDate(props.DTEND);
    assert.deepEqual(
        [start.getFullYear(), start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()],
        [2026, 5, 1, 15, 30]
    );
    assert.deepEqual(
        [end.getFullYear(), end.getMonth() + 1, end.getDate(), end.getHours(), end.getMinutes()],
        [2026, 5, 1, 17, 0]
    );
});

test('ics: title, location and description are written and readable', () => {
    const text = CalendarCore.generateICS(baseEvent, { now: FIXED_NOW });
    const props = ics.properties(text);
    assert.equal(ics.unescapeText(props.SUMMARY), 'Design Review');
    assert.equal(ics.unescapeText(props.LOCATION), 'Studio 2');
    assert.equal(ics.unescapeText(props.DESCRIPTION), 'Bring wireframes');
});

test('ics: a missing end time is one hour and is declared openly', () => {
    const text = CalendarCore.generateICS(withEvent({ endTime: '' }), { now: FIXED_NOW });
    const props = ics.properties(text);
    const start = ics.stampToLocalDate(props.DTSTART);
    const end = ics.stampToLocalDate(props.DTEND);
    assert.equal(end.getTime() - start.getTime(), 60 * 60 * 1000);
    assert.match(ics.unescapeText(props['X-CALSNAP-NOTE']), /No end time was supplied/);
});

test('ics: special characters are escaped so the file stays parseable', () => {
    const text = CalendarCore.generateICS(withEvent({
        title: 'Lunch; with Ana, Bo',
        description: 'Line one\nLine two, with commas; and a \\ backslash',
        location: 'Cafe, 5th floor'
    }), { now: FIXED_NOW });

    const props = ics.properties(text);
    assert.match(props.SUMMARY, /\\;/);
    assert.match(props.SUMMARY, /\\,/);
    assert.match(props.DESCRIPTION, /\\n/);

    // The unescaped values must match exactly what the user typed.
    assert.equal(ics.unescapeText(props.SUMMARY), 'Lunch; with Ana, Bo');
    assert.equal(ics.unescapeText(props.LOCATION), 'Cafe, 5th floor');
    assert.equal(ics.unescapeText(props.DESCRIPTION), 'Line one\nLine two, with commas; and a \\ backslash');

    // A raw CR/LF inside a value would corrupt the file.
    assert.equal(/\r(?!\n)/.test(text), false);
    assert.equal(text.split('\r\n').some((line) => line.includes('\n')), false);
});

test('ics: long values are folded and unfold back to the original', () => {
    const longTitle = 'Quarterly Cross-Functional Planning and Retrospective Workshop for Platform Teams';
    const longDescription = 'Agenda: '.padEnd(200, 'x');
    const text = CalendarCore.generateICS(withEvent({ title: longTitle, description: longDescription }), { now: FIXED_NOW });

    assert.deepEqual(ics.overlongLines(text), [], 'no physical line may exceed 75 octets');
    assert.ok(text.includes('\r\n '), 'expected at least one continuation line');
    assert.equal(ics.unescapeText(ics.properties(text).SUMMARY), longTitle);
    assert.equal(ics.unescapeText(ics.properties(text).DESCRIPTION), longDescription);
});

test('ics: no reminder selected means no VALARM at all', () => {
    const text = CalendarCore.generateICS(withEvent({ reminder: 'none' }), { now: FIXED_NOW });
    assert.equal(text.includes('VALARM'), false);
    assert.equal(ics.allValues(text, 'TRIGGER').length, 0);
});

test('ics: each reminder option produces the right TRIGGER', () => {
    const expected = { '15': '-PT15M', '60': '-PT60M', '1440': '-PT1440M' };
    for (const [reminder, trigger] of Object.entries(expected)) {
        const text = CalendarCore.generateICS(withEvent({ reminder }), { now: FIXED_NOW });
        assert.equal((text.match(/BEGIN:VALARM/g) || []).length, 1, 'reminder ' + reminder);
        assert.equal((text.match(/END:VALARM/g) || []).length, 1, 'reminder ' + reminder);
        assert.deepEqual(ics.allValues(text, 'TRIGGER'), [trigger], 'reminder ' + reminder);
        assert.deepEqual(ics.allValues(text, 'ACTION'), ['DISPLAY'], 'reminder ' + reminder);
        assert.ok(text.indexOf('TRIGGER') > text.indexOf('DTSTART'), 'VALARM must follow the event properties');
    }
});

test('ics: the alarm text names the event so the notification is useful', () => {
    const text = CalendarCore.generateICS(withEvent({ reminder: '15' }), { now: FIXED_NOW });
    const description = ics.allValues(text, 'DESCRIPTION');
    // One DESCRIPTION for the event and one for the alarm.
    assert.equal(description.length, 2);
    assert.match(ics.unescapeText(description[1]), /Design Review/);
    assert.match(ics.unescapeText(description[1]), /15 minutes before/);
});

test('ics: the alarm trigger matches the selected reminder in minutes', () => {
    const text = CalendarCore.generateICS(withEvent({ reminder: '60' }), { now: FIXED_NOW });
    const trigger = ics.allValues(text, 'TRIGGER')[0];
    const minutes = parseInt(trigger.replace(/^-PT/, '').replace(/M$/, ''), 10);
    assert.equal(minutes, 60);
});

test('ics: an unknown reminder value is ignored, not written as garbage', () => {
    const text = CalendarCore.generateICS(withEvent({ reminder: 'banana' }), { now: FIXED_NOW });
    assert.equal(text.includes('VALARM'), false);
});

test('ics: midnight and late-evening events keep the correct day', () => {
    const text = CalendarCore.generateICS(withEvent({ startTime: '00:30', endTime: '01:30' }), { now: FIXED_NOW });
    const props = ics.properties(text);
    const start = ics.stampToLocalDate(props.DTSTART);
    assert.equal(start.getDate(), 1);
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 30);
});

test('ics: file names are safe for every operating system', () => {
    const name = CalendarCore.suggestFileName({ title: 'Q3/Q4 Review: "final" <draft> | #1', date: '2026-05-01' });
    assert.equal(/[\\/:*?"<>|]/.test(name), false);
    assert.match(name, /\.ics$/);
    assert.equal(CalendarCore.suggestFileName({ title: '', date: '' }), 'event.ics');
});

/* -------------------------------------------------------------------------- *
 * Sharing text (Step 9) - claims nothing about saving
 * -------------------------------------------------------------------------- */

test('share: text carries the details and claims nothing was saved', () => {
    const text = CalendarCore.buildShareText(baseEvent);
    assert.match(text, /Design Review/);
    assert.match(text, /15:30/);
    assert.match(text, /Studio 2/);
    assert.doesNotMatch(text, /saved|added|scheduled|created/i);
});

test('share: the reminder notice never promises a notification', () => {
    assert.match(CalendarCore.GOOGLE_REMINDER_NOTICE, /does not accept a reminder from a link/i);
    assert.match(CalendarCore.GOOGLE_REMINDER_NOTICE, /does not save the event/i);
    assert.match(CalendarCore.ICS_REMINDER_NOTICE, /ignore imported reminders/i);
});
