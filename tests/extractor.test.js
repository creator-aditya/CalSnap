/**
 * CalSnap extraction tests - Step 4 (automatic extraction) and Step 13 items 1-5.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Extractor } = require('./load-globals.js');

// A fixed clock keeps relative-date tests deterministic ("tomorrow" etc.).
const FRIDAY = new Date(2026, 0, 2, 10, 0, 0); // Friday 2 January 2026, 10:00 local
const DECEMBER = new Date(2025, 11, 20, 9, 0, 0); // Saturday 20 December 2025

function extract(text, now = FRIDAY) {
    return Extractor.extract(text, { now });
}

test('returns null for empty input', () => {
    assert.equal(Extractor.extract(''), null);
    assert.equal(Extractor.extract('   \n  '), null);
});

test('title: explicit label wins', () => {
    const result = extract('Event: Q3 Budget Review\nDate: 2026-05-01\nTime: 09:00 AM');
    assert.equal(result.title, 'Q3 Budget Review');
    assert.equal(result.sources.title, 'label');
});

test('title: first meaningful line, with a leading date stripped', () => {
    const result = extract('March 3, 2026 - Team sync\nLocation: Room 12');
    assert.equal(result.title, 'Team sync');
});

test('title: skips greeting, date label and URL-only lines', () => {
    const result = extract([
        'Hi there,',
        'Date: 12 May 2026',
        'Join us for the Annual Design Summit',
        'https://example.com/events/design-summit'
    ].join('\n'));
    assert.equal(result.title, 'Join us for the Annual Design Summit');
    assert.equal(result.date, '2026-05-12');
});

test('title: a link in the text never overrides the real title', () => {
    const result = extract('Design Summit\n2026-05-01 at 10:00\nhttps://example.com/events/spring-product-launch');
    assert.equal(result.title, 'Design Summit');
});

test('title: falls back to the URL slug when only a link is shared', () => {
    const result = extract('https://example.com/events/spring-product-launch');
    assert.equal(result.title, 'spring product launch');
});

test('date: ISO date is kept exactly, with no timezone shift', () => {
    // Regression: the old build ran the date through toISOString(), which moved
    // the day backwards for users west of UTC.
    const result = extract('Workshop 2026-03-15 at 09:00');
    assert.equal(result.date, '2026-03-15');
});

test('date: numeric month/day/year', () => {
    assert.equal(extract('Meeting on 05/01/2026 at 10:00').date, '2026-05-01');
});

test('date: unambiguous day/month/year is detected', () => {
    assert.equal(extract('Meeting on 15/03/2026 at 10:00').date, '2026-03-15');
});

test('date: month name with a year', () => {
    assert.equal(extract('Gala on April 22, 2026 at 7 PM').date, '2026-04-22');
    assert.equal(extract('Summit on March 12, 2026 at 09:30').date, '2026-03-12');
});

test('date: a month/day already past rolls to next year', () => {
    assert.equal(extract('Kickoff on Jan 5 at 09:00', DECEMBER).date, '2026-01-05');
    assert.equal(extract('Gala on April 22 at 7 PM', DECEMBER).date, '2026-04-22');
});

test('date: relative words resolve against the reference day', () => {
    assert.equal(extract('Lunch tomorrow at 12 PM').date, '2026-01-03');
    assert.equal(extract('Standup today at 09:00').date, '2026-01-02');
    assert.equal(extract('Review in 3 days at 14:00').date, '2026-01-05');
    assert.equal(extract('Planning next week at 10:00').date, '2026-01-09');
    assert.equal(extract('Retro next month at 10:00').date, '2026-02-02');
});

test('date: bare weekday means the next occurrence', () => {
    assert.equal(extract('Yoga Friday at 6 PM').date, '2026-01-09'); // not today
    assert.equal(extract('Yoga Monday at 6 PM').date, '2026-01-05');
});

test('date: impossible dates are refused, not guessed', () => {
    const result = extract('Party 2026-02-30 at 8 PM');
    assert.equal(result.date, '');
    assert.ok(result.missing.includes('date'));
});

test('time: 12-hour values convert correctly (the old 12 AM/PM bug)', () => {
    assert.equal(extract('Call at 2 PM').startTime, '14:00');
    assert.equal(extract('Call at 2:30pm').startTime, '14:30');
    assert.equal(extract('Call at 12 PM').startTime, '12:00');
    assert.equal(extract('Call at 12:30 AM').startTime, '00:30');
    assert.equal(extract('Call at 12 AM').startTime, '00:00');
    assert.equal(extract('Call at 9 AM').startTime, '09:00');
});

test('time: 24-hour values and noon/midnight', () => {
    assert.equal(extract('Call at 14:45').startTime, '14:45');
    assert.equal(extract('Call at noon').startTime, '12:00');
    assert.equal(extract('Call at midnight').startTime, '00:00');
});

test('time: an explicit range fills the end time', () => {
    assert.equal(extract('Workshop 3:30 PM to 5:00 PM').endTime, '17:00');
    assert.equal(extract('Workshop from 09:00 - 11:00').endTime, '11:00');
    assert.equal(extract('Workshop 22:00 until 23:30').endTime, '23:30');
});

test('time: ranges sharing one meridiem are resolved sensibly', () => {
    const pm = extract('Open house 2 to 4 PM');
    assert.equal(pm.startTime, '14:00');
    assert.equal(pm.endTime, '16:00');

    const am = extract('Breakfast 9 to 11 AM');
    assert.equal(am.startTime, '09:00');
    assert.equal(am.endTime, '11:00');
});

test('time: no end time is invented for a single time', () => {
    const result = extract('Client call March 3, 2026 at 11:00');
    assert.equal(result.startTime, '11:00');
    assert.equal(result.endTime, '', 'an unknown end time must stay empty for the user to decide');
});

test('time: a time range never points backwards', () => {
    const result = extract('Shift 14:00 to 09:00');
    assert.equal(result.startTime, '14:00');
    assert.equal(result.endTime, '');
});

test('location: labelled field', () => {
    const result = extract('Team sync\nDate: May 1, 2026 at 3:30 PM\nLocation: Room 4, Building B');
    assert.equal(result.location, 'Room 4, Building B');
});

test('location: "at"/"in" phrase, without swallowing a time', () => {
    assert.equal(extract('Client call at The Ritz tomorrow at 3:30pm').location, 'The Ritz');
    assert.equal(extract('Meet in Room 4, Building B on 2026-05-01 at 09:00').location, 'Room 4, Building B');
});

test('location: a time after "at" is never treated as a location', () => {
    const result = extract('Standup tomorrow at 09:00');
    assert.equal(result.location, '');
});

test('location: stops before the next labelled field', () => {
    const result = extract('Concert\nWhere: Sunset Arena\nDate: 2026-07-04\nTime: 8 PM');
    assert.equal(result.location, 'Sunset Arena');
});

test('description: the user text is retained in full', () => {
    const text = [
        'Design Review',
        'Date: 2026-05-01 at 3:30 PM',
        'Location: Studio 2',
        'Bring the latest wireframes and the usability notes.'
    ].join('\n');
    const result = extract(text);
    assert.match(result.description, /Bring the latest wireframes and the usability notes\./);
    assert.equal(result.description.includes('\r'), false);
});

test('links: kept as links, never used as the location', () => {
    const text = 'Community meetup\nMay 9, 2026 at 18:00\nDetails: https://example.com/meetup';
    const result = extract(text);
    assert.deepEqual(result.urls, ['https://example.com/meetup']);
    assert.equal(result.location, '');
    assert.match(result.description, /https:\/\/example\.com\/meetup/);
});

test('links: a shared URL alone is reported honestly instead of faked', () => {
    const feedback = Extractor.urlOnlyFeedback('https://example.com/events/summit-2026');
    assert.ok(feedback, 'expected URL-only feedback');
    assert.match(feedback.message, /cannot read a webpage/i);
    assert.match(feedback.message, /paste it here/i);
    assert.equal(feedback.url, 'https://example.com/events/summit-2026');
});

test('links: URL plus real text is not treated as URL-only', () => {
    const text = 'Design Summit on 2026-05-01 at 10:00 https://example.com/summit';
    assert.equal(Extractor.urlOnlyFeedback(text), null);
    assert.equal(Extractor.hasUrl(text), true);
});

test('missing: required details are reported so the UI can ask', () => {
    const result = extract('Team offsite sometime soonish');
    assert.deepEqual(result.missing.sort(), ['date', 'startTime']);
    assert.equal(result.title, 'Team offsite sometime soonish');
});

test('full workflow example produces every field', () => {
    const result = extract([
        'Annual Design Summit',
        'Date: March 12, 2026',
        'Time: 9:30 AM - 4:00 PM',
        'Location: Riverside Convention Centre, Hall B',
        'Join 300 designers for a full day of talks and workshops.'
    ].join('\n'));

    assert.equal(result.title, 'Annual Design Summit');
    assert.equal(result.date, '2026-03-12');
    assert.equal(result.startTime, '09:30');
    assert.equal(result.endTime, '16:00');
    assert.equal(result.location, 'Riverside Convention Centre, Hall B');
    assert.match(result.description, /Join 300 designers/);
    assert.deepEqual(result.missing, []);
});

/*
 * Regression: text shared from a web page arrives as ONE long paragraph, with the
 * event name embedded in the middle of a sentence. An earlier build rejected any
 * candidate containing "AM"/"PM" as if it were a timestamp, so the whole paragraph
 * was discarded and the user saw "No event title could be found" for text that
 * plainly contained the name.
 */
test('paragraph: a single-block page description still yields a title', () => {
    const paragraph = 'The NextGen AI & Tech Summit 2026 will take place on Thursday, November 12, 2026, ' +
        'from 09:00 AM to 05:00 PM IST (with registration opening early at 08:15 AM). This premier industry ' +
        'event, hosted by the Nexus Innovations Group, will be held at The Grand Ballroom inside the ITC Grand ' +
        'Chola, located at No. 63, Anna Salai, Guindy, Chennai, Tamil Nadu, 600032. Attendees can look forward ' +
        'to a full day of keynote speeches, interactive panel discussions, and structured networking sessions.';

    const result = extract(paragraph);

    assert.equal(result.title, 'The NextGen AI & Tech Summit 2026');
    assert.equal(result.date, '2026-11-12');
    assert.equal(result.startTime, '09:00');
    assert.equal(result.endTime, '17:00');
    assert.equal(result.location, 'The Grand Ballroom');
    assert.deepEqual(result.missing, [], 'nothing should be reported missing for this text');
});

test('paragraph: the title is trimmed at the first clause that describes the event', () => {
    const result = extract('Join us for the Riverside Summer Gala, which will take place on 2026-07-18 at 19:00. ' +
        'Dinner, music and a charity auction follow.');
    assert.equal(result.title, 'Join us for the Riverside Summer Gala');
    assert.equal(result.date, '2026-07-18');
    assert.equal(result.startTime, '19:00');
});

test('paragraph: an aside in brackets does not leak into the title', () => {
    const result = extract('Winter Concert will take place on Friday, 18 December 2026, 7:00 PM ' +
        '(doors open at 06:30 PM). Tickets include a welcome drink.');
    assert.equal(result.title, 'Winter Concert');
    assert.equal(result.date, '2026-12-18');
    assert.equal(result.startTime, '19:00');
});

test('paragraph: a long name is kept, not truncated at a comma or date', () => {
    const title = 'Quarterly Cross-Functional Planning and Retrospective Workshop for Platform Teams';
    const result = extract(title + ' takes place on 2026-09-04 at 14:00 in Room 4.');
    assert.equal(result.title, title);
    assert.equal(result.date, '2026-09-04');
    assert.equal(result.startTime, '14:00');
});

test('title: a name that merely contains digits is not mistaken for a timestamp', () => {
    // Guards the opposite failure: rejecting real names because they hold a date.
    // A short line keeps its date (the user can trim it); the point is that the
    // name survives and the date is still picked up as the date.
    const short = extract('Webinar 2026-04-08 15:00');
    assert.ok(short.title.startsWith('Webinar'), 'the name must survive, got: ' + JSON.stringify(short.title));
    assert.equal(short.date, '2026-04-08');
    assert.equal(short.startTime, '15:00');

    assert.equal(extract('Q3 2026 Planning on 2026-10-01 at 09:00').title, 'Q3 2026 Planning');
    assert.equal(extract('Annual Design Summit 2026').title, 'Annual Design Summit 2026');
});

test('title: a candidate that is only a date or time is still refused', () => {
    // These must never become the event name.
    assert.equal(extract('9:30 AM').title, '');
    assert.equal(extract('2026-03-15').title, '');
    assert.equal(extract('Friday, 18 December 2026, 7:00 PM').title, '');
    assert.equal(extract('on 2026-05-01 at 10:00').title, '');
});

test('extraction is pure: the same input always gives the same output', () => {
    const text = 'Studio Session\n2026-06-10 at 19:00\nLocation: Blue Note';
    assert.deepEqual(extract(text), extract(text));
});
