/**
 * CalSnap validation tests - Step 5 and Step 13 item 7.
 *
 * Validation is what stands between "the model guessed something" and "a wrong
 * event landed in someone's calendar", so these cases are deliberately strict:
 * required details block the action, questionable details warn instead.
 *
 * Run with: npm test      (or: node --test tests)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Validation } = require('./load-globals.js');

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

test('validation: a complete event passes with no errors', () => {
    const result = Validation.validate(baseEvent, { now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test('validation: required fields are reported one by one', () => {
    const result = Validation.validate(
        { title: '', date: '', startTime: '', endTime: '', reminder: 'none' },
        { now: FIXED_NOW }
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => e.field).sort(), ['date', 'startTime', 'title']);
    for (const error of result.errors) {
        assert.ok(error.message.length > 5, 'each error must explain itself');
    }
});

test('validation: impossible or malformed values are rejected', () => {
    assert.equal(Validation.isDate('2026-02-30'), false);
    assert.equal(Validation.isDate('2026-13-01'), false);
    assert.equal(Validation.isDate('01/05/2026'), false);
    assert.equal(Validation.isDate('2028-02-29'), true, 'leap day is valid');

    const result = Validation.validate(withEvent({ date: '2026-02-30' }), { now: FIXED_NOW });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, 'date');
});

test('validation: an end time before the start is an error the user must fix', () => {
    const result = Validation.validate(withEvent({ startTime: '15:30', endTime: '14:00' }), { now: FIXED_NOW });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, 'endTime');
    assert.match(result.errors[0].message, /before the start time/i);
});

test('validation: zero-length events are refused', () => {
    const result = Validation.validate(withEvent({ startTime: '15:30', endTime: '15:30' }), { now: FIXED_NOW });
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /different from the start time/i);
});

test('validation: a missing end time only warns, and says what will happen', () => {
    const result = Validation.validate(withEvent({ endTime: '' }), { now: FIXED_NOW });
    assert.equal(result.ok, true, 'a missing end time must not block the user');
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].field, 'endTime');
    assert.match(result.warnings[0].message, /one hour long \(15:30 to 16:30\)/);
    assert.equal(Validation.effectiveEndTime(withEvent({ endTime: '' })), '16:30');
});

test('validation: late starts do not roll the default end into the next day', () => {
    assert.equal(Validation.defaultEndTime('23:30'), '23:59');
    assert.equal(Validation.defaultEndTime('09:05'), '10:05');
    assert.equal(Validation.defaultEndTime(''), '');
});

test('validation: a past date warns without blocking', () => {
    const result = Validation.validate(withEvent({ date: '2026-01-05' }), { now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(result.warnings[0].field, 'date');
    assert.match(result.warnings[0].message, /past/i);
});

test('validation: a very distant date warns', () => {
    const result = Validation.validate(withEvent({ date: '2040-05-01' }), { now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.match(result.warnings[0].message, /five years away/i);
});

test('validation: whitespace is trimmed and values are normalised', () => {
    const result = Validation.validate(
        withEvent({ title: '   Design   Review  ', location: '  Studio 2  ' }),
        { now: FIXED_NOW }
    );
    assert.equal(result.event.title, 'Design Review');
    assert.equal(result.event.location, 'Studio 2');
});

test('validation: an unknown reminder falls back to none, with a warning', () => {
    const result = Validation.validate(withEvent({ reminder: 'soon' }), { now: FIXED_NOW });
    assert.equal(result.event.reminder, 'none');
    assert.match(result.warnings[0].message, /reminder/i);
});

test('validation: an over-long title is refused rather than truncated', () => {
    const result = Validation.validate(withEvent({ title: 'x'.repeat(201) }), { now: FIXED_NOW });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, 'title');
});

test('validation: invalid time strings are refused', () => {
    assert.equal(Validation.isTime('25:00'), false);
    assert.equal(Validation.isTime('9:5'), false);
    assert.equal(Validation.isTime('09:05'), true);
    assert.equal(Validation.isTime('23:59'), true);

    const result = Validation.validate(withEvent({ startTime: '99:99' }), { now: FIXED_NOW });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, 'startTime');
});

test('validation: the summary reads like a date a person recognises', () => {
    assert.equal(Validation.describe(baseEvent), 'Friday, 1 May 2026 at 15:30');
    assert.equal(Validation.describe({ date: '', startTime: '' }), '');
});
